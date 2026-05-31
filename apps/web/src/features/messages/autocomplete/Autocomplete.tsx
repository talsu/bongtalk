import { useEffect, useRef } from 'react';
import { cn } from '../../../lib/cn';
import type { AutocompleteRow } from './useAutocomplete';
import type { TriggerKind } from './detectTrigger';

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
 */
const SECTION_LABEL: Record<TriggerKind, string> = {
  mention: '멤버',
  channel: '채널',
  emoji: '이모지',
};

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
      aria-label={`${SECTION_LABEL[kind]} 자동완성`}
      data-testid={`autocomplete-${kind}`}
      className="qf-autocomplete"
      style={{ maxHeight: `${maxHeight}px` }}
    >
      <li className="qf-autocomplete__header" role="presentation" aria-hidden="true">
        {SECTION_LABEL[kind]}
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
  if (row.type === 'channel') return `c-${row.channel.id}`;
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
