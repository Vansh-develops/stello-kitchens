import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { MEDIA_LIMITS, type AuthUser } from "@stello/shared";
import { CurrentUser, Public, RequirePermission } from "../common/decorators";
import { MediaService } from "./media.service";
import { SAFE_KEY } from "./media.storage";

type UploadedImage = { buffer: Buffer; size: number; mimetype: string; originalname: string };

const CONTENT_TYPE: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

@RequirePermission("menu.manage")
@Controller("outlets/:outletId/menu/items/:itemId/image")
export class ItemImageController {
  constructor(private readonly media: MediaService) {}

  // Multipart upload, held in memory (bounded by the multer size limit below,
  // then re-checked by type/size/dimension validation in the service).
  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: Number(process.env.MEDIA_MAX_BYTES) || MEDIA_LIMITS.maxBytes, files: 1 },
    }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @Param("outletId") outletId: string,
    @Param("itemId") itemId: string,
    @UploadedFile() file: UploadedImage | undefined,
  ) {
    return this.media.setItemImage(user, outletId, itemId, file);
  }

  @Delete()
  remove(@CurrentUser() user: AuthUser, @Param("outletId") outletId: string, @Param("itemId") itemId: string) {
    return this.media.clearItemImage(user, outletId, itemId);
  }
}

// Public read of locally stored menu photos (they appear on the diner menu).
@Public()
@Controller("media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get(":kind/:scope/:file")
  async get(
    @Param("kind") kind: string,
    @Param("scope") scope: string,
    @Param("file") file: string,
    @Res() res: Response,
  ) {
    const key = `${kind}/${scope}/${file}`;
    if (!SAFE_KEY.test(key)) throw new NotFoundException();
    const body = await this.media.read(key);
    if (!body) throw new NotFoundException();
    res.setHeader("Content-Type", CONTENT_TYPE[key.split(".").pop() as string]);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(body);
  }
}
