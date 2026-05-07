import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Connect Kafka consumer for ai.message.moderated
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'chat-service',
        brokers: [process.env.KAFKA_BROKER || 'redpanda:9092'],
      },
      consumer: {
        groupId: 'chat-service-consumer',
      },
    },
  });

  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');

  await app.startAllMicroservices();

  const port = process.env.PORT || 3040;
  await app.listen(port);

  console.log(`Chat service running on port ${port}`);
  console.log(`Kafka consumer connected to ${process.env.KAFKA_BROKER || 'redpanda:9092'}`);
}
bootstrap();
