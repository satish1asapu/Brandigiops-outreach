// outreach.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Target, TargetSchema } from './schemas/target.schema';
import { OutreachLink, OutreachLinkSchema } from './schemas/outreach-link.schema';
import {
  ClientOnboarding,
  ClientOnboardingSchema,
} from './schemas/client-onboarding.schema';
import { OutreachService } from './outreach.service';
import { OutreachController } from './outreach.controller';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Target.name, schema: TargetSchema },
      { name: OutreachLink.name, schema: OutreachLinkSchema },
      { name: ClientOnboarding.name, schema: ClientOnboardingSchema },
    ]),
  ],
  controllers: [OutreachController],
  providers: [OutreachService, WhatsAppService],
  exports: [OutreachService],
})
export class OutreachModule {}
