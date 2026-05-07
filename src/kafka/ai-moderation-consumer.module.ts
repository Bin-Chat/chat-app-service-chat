import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModerationConsumer } from './ai-moderation.consumer';
import { Message, MessageSchema } from '../chat/schemas/message.schema';
import { Conversation, ConversationSchema } from '../chat/schemas/conversation.schema';
import { KafkaProducerModule } from '../kafka/kafka-producer.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: Conversation.name, schema: ConversationSchema },
    ]),
    KafkaProducerModule,
  ],
  controllers: [AiModerationConsumer],
})
export class AiModerationConsumerModule {}
