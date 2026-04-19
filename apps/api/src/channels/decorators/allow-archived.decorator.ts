import { SetMetadata } from '@nestjs/common';
import { ALLOW_ARCHIVED_KEY } from '../guards/channel-access.guard';

/** Opts a route out of the default "archived = read-only" rule. */
export const AllowArchivedChannel = () => SetMetadata(ALLOW_ARCHIVED_KEY, true);
