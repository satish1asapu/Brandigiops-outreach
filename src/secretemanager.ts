import { Module } from '@nestjs/common';
import { SecretManagerService } from './services/secretmanagerService';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [SecretManagerService],
  exports: [SecretManagerService],
})
export class SecretManagerModule {}
