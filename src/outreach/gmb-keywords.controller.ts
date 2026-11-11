import { BadRequestException, Controller, Get, Post, Query } from '@nestjs/common';
import { GmbKeywordsService } from './gmb-keywords.service';

/** Drop-in for main marketops API: GET /gmbKeywords/get → gmbkeywords */
@Controller('gmbKeywords')
export class GmbKeywordsController {
  constructor(private readonly gmbKeywordsService: GmbKeywordsService) {}

  /** PostProxy → gmbkeywords (all locations on client unless gmbId filters sync via outreach route). */
  @Post('sync')
  syncKeywords(
    @Query('clientId') clientId: string,
    @Query('placeId') placeId?: string,
    @Query('fromMonth') fromMonth?: string,
    @Query('toMonth') toMonth?: string,
  ) {
    if (!clientId?.trim()) {
      throw new BadRequestException('clientId query param is required');
    }
    return this.gmbKeywordsService.syncKeywordsForClient(clientId.trim(), placeId, {
      fromMonth,
      toMonth,
    });
  }

  @Get('get')
  getKeywords(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('clientId') clientId?: string,
    @Query('gmbId') gmbId?: string,
  ) {
    return this.gmbKeywordsService.getKeywords(
      clientId ?? '',
      gmbId ?? '',
      startDate,
      endDate,
    );
  }
}
