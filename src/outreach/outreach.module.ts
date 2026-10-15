// outreach.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Target, TargetSchema } from './schemas/target.schema';
import { OutreachLink, OutreachLinkSchema } from './schemas/outreach-link.schema';
import {
  ClientOnboarding,
  ClientOnboardingSchema,
} from './schemas/client-onboarding.schema';
import { ClientCustomer, ClientCustomerSchema } from './schemas/client-customer.schema';
import { OutreachService } from './outreach.service';
import { OutreachController } from './outreach.controller';
import { WhatsAppService } from './whatsapp.service';
import { ReviewFollowUpService } from './review-followup.service';
import { SerpApiReviewDetector, REVIEW_DETECTOR } from './review-detector';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Target.name, schema: TargetSchema },
      { name: OutreachLink.name, schema: OutreachLinkSchema },
      { name: ClientOnboarding.name, schema: ClientOnboardingSchema },
      { name: ClientCustomer.name, schema: ClientCustomerSchema },
    ]),
  ],
  controllers: [OutreachController],
  providers: [
    OutreachService,
    WhatsAppService,
    ReviewFollowUpService,
    { provide: REVIEW_DETECTOR, useClass: SerpApiReviewDetector },
  ],
  exports: [OutreachService],
})
export class OutreachModule {}
