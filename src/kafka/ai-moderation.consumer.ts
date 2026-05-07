import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message, MessageDocument } from '../chat/schemas/message.schema';
import { Conversation, ConversationDocument } from '../chat/schemas/conversation.schema';
import { KafkaProducerService } from './kafka-producer.service';
import { CHAT_EVENTS } from './events/chat.events';

interface AiMessageModeratedEvent {
  messageId: string;
  conversationId: string;
  senderId: string;
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  timestamp: string;
}

@Controller()
export class AiModerationConsumer {
  private readonly logger = new Logger(AiModerationConsumer.name);

  constructor(
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
    private kafkaProducer: KafkaProducerService,
  ) {}

  @EventPattern('ai.message.moderated')
  async handleModeratedMessage(@Payload() event: AiMessageModeratedEvent): Promise<void> {
    if (!event.flagged) return;

    this.logger.warn(
      `Auto-revoking flagged message ${event.messageId}. Categories: ${Object.keys(event.categories)
        .filter((k) => event.categories[k])
        .join(', ')}`,
    );

    try {
      const message = await this.messageModel.findById(event.messageId);
      if (!message || message.revokedAt) return;

      message.revokedAt = new Date();
      await message.save();

      const conv = await this.conversationModel.findById(event.conversationId);
      const participantIds = conv?.participants.map((p) => p.userId) || [];

      // Update conv.lastMessage.revokedAt if this was the last message
      if (conv?.lastMessage?.messageId === event.messageId) {
        await this.conversationModel.updateOne(
          { _id: event.conversationId },
          { $set: { 'lastMessage.revokedAt': message.revokedAt } },
        );
      }

      await this.kafkaProducer.emit(CHAT_EVENTS.MESSAGE_REVOKED, {
        messageId: event.messageId,
        conversationId: event.conversationId,
        senderId: event.senderId,
        participants: participantIds,
        revokedAt: message.revokedAt,
        revokedBy: 'ai-moderation',
        attachmentUrls: message.attachments?.map((a: any) => a.url) ?? [],
      });

      this.logger.log(`Message ${event.messageId} auto-revoked by AI moderation`);
    } catch (error) {
      this.logger.error(
        `Failed to auto-revoke message ${event.messageId}: ${error.message}`,
      );
    }
  }
}
