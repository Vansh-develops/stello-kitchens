import { Module } from "@nestjs/common";
import { ItemImageController, MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { MEDIA_STORAGE, storageFromEnv } from "./media.storage";

@Module({
  controllers: [ItemImageController, MediaController],
  providers: [MediaService, { provide: MEDIA_STORAGE, useFactory: () => storageFromEnv() }],
})
export class MediaModule {}
