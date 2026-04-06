import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class KafkaProducerService implements OnModuleInit {
  private readonly logger = new Logger(KafkaProducerService.name);

  constructor(@Inject('KAFKA_CLIENT') private readonly kafkaClient: ClientKafka) {}

  async onModuleInit() {
    await this.kafkaClient.connect();
    this.logger.log('Kafka producer connected');
  }

  async emit(topic: string, data: object): Promise<void> {
    try {
      await lastValueFrom(this.kafkaClient.emit(topic, data));
    } catch (error) {
      this.logger.error(`Failed to emit event to topic "${topic}": ${error.message}`);
    }
  }
}
