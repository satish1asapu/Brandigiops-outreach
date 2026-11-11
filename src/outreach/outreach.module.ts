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

import {
  EngageEndCustomer,
  EngageEndCustomerSchema,
} from './schemas/engage-end-customer.schema';

import { GmbReviews, GmbReviewsSchema } from './schemas/gmb-reviews.schema';

import {

  GmbMetricImpressions,

  GmbMetricImpressionsSchema,

} from './schemas/gmb-metric-impressions.schema';

import { GmbPosts, GmbPostsSchema } from './schemas/gmb-posts.schema';
import { GmbKeywords, GmbKeywordsSchema } from './schemas/gmb-keywords.schema';

import { GmbReviewsService } from './gmb-reviews.service';

import { GmbImpressionsService } from './gmb-impressions.service';

import { SerpApiReviewsService } from './serpapi-reviews.service';

import { PostProxyEnvService } from './postproxy-env.service';

import { PostProxyMetricsService } from './postproxy-metrics.service';
import { PostProxyKeywordsService } from './postproxy-keywords.service';

import { GmbSerpBundleService } from './gmb-serp-bundle.service';

import { PostProxyCommentsService } from './postproxy-comments.service';

import { PostProxyPostsService } from './postproxy-posts.service';

import { GmbPostsService } from './gmb-posts.service';

import { OutreachService } from './outreach.service';

import { OutreachController } from './outreach.controller';
import { GmbMetricImpressionsController } from './gmb-metric-impressions.controller';
import { GmbKeywordsController } from './gmb-keywords.controller';
import { GmbKeywordsService } from './gmb-keywords.service';

import { WhatsAppService } from './whatsapp.service';

import { ReviewFollowUpService } from './review-followup.service';

import { PostProxyCustomerReviewMonitorService } from './postproxy-customer-review-monitor.service';

import { EngageLeadIntroService } from './engage-lead-intro.service';

import { GmbDailySyncService } from './gmb-daily-sync.service';

import { EngageCustomerFollowUpService } from './engage-customer-followup.service';

import { SerpApiReviewDetector, REVIEW_DETECTOR } from './review-detector';



@Module({

  imports: [

    MongooseModule.forFeature([

      { name: Target.name, schema: TargetSchema },

      { name: OutreachLink.name, schema: OutreachLinkSchema },

      { name: ClientOnboarding.name, schema: ClientOnboardingSchema },

      { name: ClientCustomer.name, schema: ClientCustomerSchema },

      { name: EngageEndCustomer.name, schema: EngageEndCustomerSchema },

      { name: GmbReviews.name, schema: GmbReviewsSchema },

      { name: GmbMetricImpressions.name, schema: GmbMetricImpressionsSchema },

      { name: GmbPosts.name, schema: GmbPostsSchema },

      { name: GmbKeywords.name, schema: GmbKeywordsSchema },

    ]),

  ],

  controllers: [
    OutreachController,
    GmbMetricImpressionsController,
    GmbKeywordsController,
  ],

  providers: [

    OutreachService,

    WhatsAppService,

    EngageLeadIntroService,

    EngageCustomerFollowUpService,

    ReviewFollowUpService,

    PostProxyCustomerReviewMonitorService,

    GmbReviewsService,

    GmbImpressionsService,

    GmbKeywordsService,

    SerpApiReviewsService,

    PostProxyEnvService,

    PostProxyMetricsService,

    PostProxyKeywordsService,

    GmbSerpBundleService,

    PostProxyCommentsService,

    PostProxyPostsService,

    GmbPostsService,

    GmbDailySyncService,

    { provide: REVIEW_DETECTOR, useClass: SerpApiReviewDetector },

  ],

  exports: [OutreachService],

})

export class OutreachModule {}


