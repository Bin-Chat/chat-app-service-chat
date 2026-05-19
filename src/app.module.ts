import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { AiModerationConsumerModule } from './kafka/ai-moderation-consumer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get('MONGO_URI', 'mongodb://mongo:27017/chat_service'),
      }),
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    ChatModule,
    AiModerationConsumerModule,
  ],
})
export class AppModule {}
