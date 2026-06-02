import { Matches } from 'class-validator';

/**
 * S42 (FR-EM05): 별칭 추가 요청. alias 형식은 CustomEmoji.name 과 동일한
 * [a-z0-9_]{2,32}. 이모지당 10개 한도·워크스페이스 내 unique(name 충돌 포함)는
 * 서비스가 검사한다.
 */
export class AddAliasDto {
  @Matches(/^[a-z0-9_]{2,32}$/)
  alias!: string;
}
