// task-078 (Family SSO / OIDC IdP): OIDC Provider 모듈.
//
// CryptoService(client_secret 복호화)를 위해 AuthModule 을 import 한다. PrismaService 와
// REDIS 는 각각 @Global(PrismaModule/RedisModule)이라 별도 import 불요. main.ts 가
// OidcProviderService 를 app.get() 으로 꺼내 sso host 에 마운트하므로 export 한다.
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OidcProviderService } from './oidc-provider.service';

@Module({
  imports: [AuthModule],
  providers: [OidcProviderService],
  exports: [OidcProviderService],
})
export class OidcModule {}
