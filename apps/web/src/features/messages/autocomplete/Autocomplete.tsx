import { useEffect, useRef } from 'react';
import type { SlashCommandItem } from '@qufox/shared-types';
import { cn } from '../../../lib/cn';
import type { AutocompleteRow } from './useAutocomplete';
import { TRIGGER_KIND_LABEL, type TriggerKind } from './detectTrigger';

/**
 * S79 fix-forward (a11y H-01): 슬래시 커맨드 option 의 접근명을 만든다.
 * 시각 행은 /name + 설명 + usageHint 를 시각 슬롯에 나눠 두지만(아이콘/meta 는
 * aria-hidden), SR 은 이 단일 라벨로 의미를 전달받는다. 설명/usageHint 가 없는
 * 커맨드도 최소 "슬래시 커맨드 /name" 은 읽히게 한다(빈 조각은 제외).
 */
export function slashOptionLabel(command: SlashCommandItem): string {
  const parts = [`슬래시 커맨드 /${command.name}`];
  if (command.description) parts.push(command.description);
  if (command.usageHint) parts.push(`사용법 ${command.usageHint}`);
  return parts.join(', ');
}

/**
 * S18 (FR-RC03/04/05/06) — 자동완성 listbox UI.
 *
 * WAI-ARIA Combobox(activedescendant 패턴)의 팝업 파트입니다. 포커스는
 * 호출부(textarea/input)에 유지되고, 본 컴포넌트는 `role=listbox` + 각 항목
 * `role=option`(aria-selected/id) 만 렌더합니다. input 쪽 aria-* 는 컴포저가
 * 답니다.
 *
 * DS 4파일은 수정하지 않고 기존 `.qf-autocomplete*` 클래스만 사용합니다:
 *   qf-autocomplete / __header / __item / __item--mention|channel|emoji /
 *   __avatar / __text / __label / __sub / __meta / __meta-dot--online /
 *   __shortcode. raw hex/px/shadow 없음.
 *
 * S78 reviewer FF6 (contract): 섹션 라벨은 detectTrigger.TRIGGER_KIND_LABEL
 * 단일 출처를 쓴다(SR 결과 공지 composerAnnouncement 와 동일 명사 공유).
 */
export function Autocomplete({
  kind,
  rows,
  activeIndex,
  listboxId,
  optionId,
  maxHeight,
  onSelect,
  onHover,
}: {
  kind: TriggerKind;
  rows: AutocompleteRow[];
  activeIndex: number;
  listboxId: string;
  /** index → option id. activedescendant 연결용. */
  optionId: (index: number) => string;
  /** 모바일 visualViewport 보정 maxHeight(px). */
  maxHeight: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}): JSX.Element {
  // A-06: 활성 option 이 스크롤 밖이면 키보드로 이동해도 보이지 않는다.
  // activeIndex 가 바뀔 때마다 활성 row 를 nearest 로 스크롤해 가시화한다.
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <ul
      role="listbox"
      id={listboxId}
      aria-label={`${TRIGGER_KIND_LABEL[kind]} 자동완성`}
      data-testid={`autocomplete-${kind}`}
      className="qf-autocomplete"
      style={{ maxHeight: `${maxHeight}px` }}
    >
      <li className="qf-autocomplete__header" role="presentation" aria-hidden="true">
        {TRIGGER_KIND_LABEL[kind]}
      </li>
      {rows.map((row, index) => (
        <Row
          key={rowKey(row, index)}
          row={row}
          selected={index === activeIndex}
          id={optionId(index)}
          rowRef={index === activeIndex ? activeRef : undefined}
          // mousedown 으로 처리해 textarea blur 전에 선택이 일어나게 한다.
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(index);
          }}
          onMouseEnter={() => onHover(index)}
        />
      ))}
    </ul>
  );
}

function rowKey(row: AutocompleteRow, index: number): string {
  if (row.type === 'special') return `sp-${row.item.key}`;
  if (row.type === 'member') return `m-${row.member.userId}`;
  if (row.type === 'role') return `r-${row.role.id}`;
  if (row.type === 'channel') return `c-${row.channel.id}`;
  if (row.type === 'slash') return `s-${row.command.id}`;
  return `e-${row.emoji.kind}-${row.emoji.name}-${index}`;
}

function Row({
  row,
  selected,
  id,
  rowRef,
  onMouseDown,
  onMouseEnter,
}: {
  row: AutocompleteRow;
  selected: boolean;
  id: string;
  /** A-06: 활성 row 에만 전달되는 ref(scrollIntoView 대상). */
  rowRef?: React.Ref<HTMLLIElement>;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseEnter: () => void;
}): JSX.Element {
  const common = {
    id,
    ref: rowRef,
    role: 'option' as const,
    'aria-selected': selected,
    onMouseDown,
    onMouseEnter,
  };

  if (row.type === 'special') {
    return (
      <li {...common} className="qf-autocomplete__item qf-autocomplete__item--mention">
        <span className="qf-autocomplete__avatar" aria-hidden="true">
          @
        </span>
        <span className="qf-autocomplete__text">
          <span className="qf-autocomplete__label">{row.item.label}</span>
          <span className="qf-autocomplete__sub">{row.item.description}</span>
        </span>
      </li>
    );
  }

  if (row.type === 'member') {
    const name = row.member.displayName || row.member.username;
    const initials = name.slice(0, 2).toUpperCase();
    return (
      <li {...common} className="qf-autocomplete__item qf-autocomplete__item--mention">
        <span className="qf-autocomplete__avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="qf-autocomplete__text qf-autocomplete__text--inline">
          <span className="qf-autocomplete__label">{name}</span>
          <span className="qf-autocomplete__sub">@{row.member.username}</span>
        </span>
        <span className="qf-autocomplete__meta">
          {/* A-05: 온라인 상태가 색(meta-dot)만으로는 SR 에 전달되지 않으므로
              sr-only 텍스트로 함께 읽힌다. */}
          <span className="sr-only">{row.online ? '온라인' : '오프라인'}</span>
          <span
            className={cn(
              'qf-autocomplete__meta-dot',
              row.online && 'qf-autocomplete__meta-dot--online',
            )}
            aria-hidden="true"
          />
        </span>
      </li>
    );
  }

  // S88a (FR-MN-03): 역할 행. @ 아바타 + 역할명(label). colorHex 가 있으면 점으로 표시
  // (DS 토큰 외 색은 사용자 데이터라 인라인 style 허용 — 역할 색상 점 표시).
  if (row.type === 'role') {
    return (
      <li
        {...common}
        className="qf-autocomplete__item qf-autocomplete__item--mention"
        aria-label={`역할 멘션: @${row.role.name}`}
      >
        <span className="qf-autocomplete__avatar" aria-hidden="true">
          @
        </span>
        <span className="qf-autocomplete__text">
          <span className="qf-autocomplete__label">{row.role.name}</span>
          <span className="qf-autocomplete__sub">역할</span>
        </span>
        {/* S88a review F13 (ui): colorHex 가 null 이어도 meta 슬롯을 유지해 멤버 행과
            우측 정렬을 맞춘다(슬롯 미렌더 시 정렬 어긋남). 색이 없으면 disabled 토큰
            색의 placeholder 점으로 슬롯을 채운다(DS 4파일 미수정 — 컴포넌트만). */}
        <span className="qf-autocomplete__meta">
          <span
            className="qf-autocomplete__meta-dot"
            style={{ backgroundColor: row.role.colorHex ?? 'var(--text-disabled)' }}
            aria-hidden="true"
          />
        </span>
      </li>
    );
  }

  if (row.type === 'channel') {
    return (
      <li {...common} className="qf-autocomplete__item qf-autocomplete__item--channel">
        <span className="qf-autocomplete__avatar" aria-hidden="true">
          #
        </span>
        <span className="qf-autocomplete__text">
          <span className="qf-autocomplete__label">{row.channel.name}</span>
          {row.channel.topic ? (
            <span className="qf-autocomplete__sub">{row.channel.topic}</span>
          ) : null}
        </span>
      </li>
    );
  }

  // S79 (FR-SC-02): 슬래시 커맨드 행. / 아이콘 + 커맨드명(label) + 짧은 설명(sub),
  // usage hint 는 우측 meta 슬롯에 모노폭으로 노출한다. 기존 qf-autocomplete* 골격을
  // 재사용하되(채널 행과 동일 레이아웃), 슬래시 전용 변형 클래스 --slash 를 함께 부여한다.
  //
  // S79 fix-forward (a11y B-01 / ui M-02): 채널 변형(--channel)을 그대로 쓰면 선택
  // (aria-selected) 시 usageHint(__meta, text-muted) 가 bg-selected 위에서 3.74:1 로
  // AA(4.5:1) 미달이었다. DS slash 클래스(qf-slash-menu__arg)도 text-muted 라 같은
  // 문제가 있고, listbox(ul/li) 레이아웃과 qf-slash-menu__item 의 독립 flex/padding 이
  // 충돌하므로, 채널 골격 + 슬래시 전용 변형 클래스(--slash) 조합을 택한다. 선택상태
  // usageHint 를 text-secondary(6.15:1 다크 / 7.66:1 라이트, AA 충족)로 올리는 규칙은
  // app-layer index.css 에 --slash 스코프로만 추가해 채널 행에는 영향이 없다.
  //
  // S79 fix-forward (a11y H-01): description/usageHint 가 없는 커맨드도 SR 이 의미를
  // 전달하도록 option 에 명시 aria-label 을 붙인다. 아이콘/meta 는 aria-hidden 이라
  // 라벨이 단일 접근명이 된다.
  if (row.type === 'slash') {
    return (
      <li
        {...common}
        className="qf-autocomplete__item qf-autocomplete__item--channel qf-autocomplete__item--slash"
        aria-label={slashOptionLabel(row.command)}
      >
        <span className="qf-autocomplete__avatar" aria-hidden="true">
          /
        </span>
        <span className="qf-autocomplete__text">
          <span className="qf-autocomplete__label">/{row.command.name}</span>
          {row.command.description ? (
            <span className="qf-autocomplete__sub">{row.command.description}</span>
          ) : null}
        </span>
        {row.command.usageHint ? (
          <span className="qf-autocomplete__meta qf-autocomplete__shortcode" aria-hidden="true">
            {row.command.usageHint}
          </span>
        ) : null}
      </li>
    );
  }

  // emoji
  const { emoji } = row;
  return (
    <li {...common} className="qf-autocomplete__item qf-autocomplete__item--emoji">
      {/* A-04: shortcode(:name:)가 접근명을 제공하므로 글리프/이미지는
          aria-hidden 처리해 중복 읽기를 막는다. */}
      <span className="qf-autocomplete__avatar" aria-hidden="true">
        {emoji.kind === 'unicode' ? emoji.glyph : <img src={emoji.url} alt="" />}
      </span>
      <span className="qf-autocomplete__shortcode">:{emoji.name}:</span>
    </li>
  );
}
