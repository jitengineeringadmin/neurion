import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

// Public client config. `restricted` = the online (no local AI engine) deployment:
// the web app then exposes only auth/account/forum and hides chat/agent/compute.
// On the desktop build AI_ONLINE_NO_ENGINE is unset, so restricted=false → full app.
@Public()
@Controller('config')
export class AppConfigController {
  @Get()
  @Header('Cache-Control', 'public, max-age=30')
  get() {
    return { restricted: process.env.AI_ONLINE_NO_ENGINE === 'true' };
  }
}
