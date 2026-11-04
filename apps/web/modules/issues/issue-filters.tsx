'use client'

import {
  ISSUE_SORTS,
  type IssueFilterDto,
  type IssueFilterOptionDto,
  type IssueGroupDto,
  type IssueListDto,
  type IssueSort,
  type IssueSortDirection,
  type IssueSortDto,
} from '@factorix/schemas'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Popover } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useIssueFilterSpecs } from '../lib/data'
import { cn } from '../lib/format'
import {
  Button,
  Input,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
} from '../ui'
import { FACTORY_STATE_LABEL, FactoryStateIcon, PriorityIcon, TrackerStateIcon } from './icons'

export const ISSUE_PAGE_SIZE = 50

const RESERVED = new Set(['page', 'scope', 'sort', 'direction'])

export type IssueScope = 'open' | 'closed' | 'all'
const SCOPES: { value: IssueScope; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]

/** Lives in the URL so going back from an issue, or sharing a link, keeps the search and filters. */
export function useIssueQuery() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const page = Math.max(1, Number(params.get('page')) || 1)
  const rawScope = params.get('scope')
  const scope: IssueScope = rawScope === 'closed' || rawScope === 'all' ? rawScope : 'open'
  const rawSort = params.get('sort')
  const sort: IssueSort = rawSort && Object.hasOwn(ISSUE_SORTS, rawSort) ? (rawSort as IssueSort) : 'updated'
  const rawDirection = params.get('direction')
  const direction: IssueSortDirection = rawDirection === 'asc' || rawDirection === 'desc' ? rawDirection : ISSUE_SORTS[sort]
  const query = useMemo(() => {
    const values: Record<string, string[]> = {}
    for (const key of new Set(params.keys())) if (!RESERVED.has(key)) values[key] = params.getAll(key)
    return values
  }, [params])

  const keepSort = useCallback(
    (next: URLSearchParams) => {
      if (sort !== 'updated') next.set('sort', sort)
      if (direction !== ISSUE_SORTS[sort]) next.set('direction', direction)
    },
    [sort, direction],
  )

  const update = useCallback(
    (patch: Record<string, string[]>, nextPage = 1) => {
      const next = new URLSearchParams()
      if (scope !== 'open') next.set('scope', scope)
      keepSort(next)
      for (const [key, values] of Object.entries({ ...query, ...patch })) for (const value of values) if (value) next.append(key, value)
      if (nextPage > 1) next.set('page', String(nextPage))
      const text = next.toString()
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
    },
    [query, scope, keepSort, pathname, router],
  )
  const clear = useCallback(() => {
    const next = new URLSearchParams()
    if (scope !== 'open') next.set('scope', scope)
    keepSort(next)
    const text = next.toString()
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
  }, [scope, keepSort, pathname, router])
  const setSort = useCallback(
    (nextSort: IssueSort, nextDirection: IssueSortDirection = ISSUE_SORTS[nextSort]) => {
      const next = new URLSearchParams()
      if (scope !== 'open') next.set('scope', scope)
      for (const [key, values] of Object.entries(query)) for (const value of values) next.append(key, value)
      if (nextSort !== 'updated') next.set('sort', nextSort)
      if (nextDirection !== ISSUE_SORTS[nextSort]) next.set('direction', nextDirection)
      const text = next.toString()
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
    },
    [query, scope, pathname, router],
  )
  // A status picked under one scope usually does not exist under another, so it would only ever empty the list.
  const setScope = useCallback(
    (nextScope: IssueScope) => {
      const next = new URLSearchParams()
      if (nextScope !== 'open') next.set('scope', nextScope)
      keepSort(next)
      for (const [key, values] of Object.entries(query)) if (key !== 'status') for (const value of values) next.append(key, value)
      const text = next.toString()
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
    },
    [query, keepSort, pathname, router],
  )
  return {
    query,
    page,
    scope,
    sort,
    direction,
    setScope,
    setSort,
    update,
    clear,
    setPage: (next: number) => update({}, next),
    active: Object.keys(query).length > 0,
  }
}

function ScopeSwitch({ scope, onChange }: { scope: IssueScope; onChange: (scope: IssueScope) => void }) {
  return (
    <fieldset className="mr-1 flex h-7 shrink-0 items-center rounded-sm border border-field p-px" aria-label="Which issues to show">
      {SCOPES.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={scope === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex h-full items-center rounded-[3px] px-2 text-xs transition-colors duration-100',
            scope === option.value ? 'bg-soft text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  )
}

function OptionIcon({ filter, option }: { filter: string; option: IssueFilterOptionDto }) {
  if (filter === 'status') return <TrackerStateIcon type={option.meta as never} />
  if (filter === 'priority') return <PriorityIcon priority={Number(option.value)} />
  if (filter === 'factoryState') return <FactoryStateIcon state={option.value as IssueGroupDto} />
  return null
}

const triggerStyle =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-field px-2 text-xs text-ink-2 transition-colors duration-100 hover:bg-soft hover:text-ink data-[active=true]:border-signal data-[active=true]:text-ink'

function MultiFilter({ filter, values, onChange }: { filter: IssueFilterDto; values: string[]; onChange: (values: string[]) => void }) {
  const label = (option: IssueFilterOptionDto) =>
    filter.key === 'factoryState' ? (FACTORY_STATE_LABEL[option.value as IssueGroupDto] ?? option.label) : option.label
  return (
    <Menu>
      <MenuTrigger className={triggerStyle} data-active={values.length > 0}>
        {filter.label}
        {values.length > 0 ? <span className="tabular-nums text-signal">{values.length}</span> : null}
        <ChevronDown className="size-3 text-ink-3" />
      </MenuTrigger>
      <MenuContent className="w-64">
        {filter.options.length === 0 ? <div className="px-2 py-1.5 text-sm text-ink-3">Nothing to filter yet</div> : null}
        {filter.options.map((option) => (
          <MenuCheckboxItem
            key={option.value}
            checked={values.includes(option.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onChange(checked ? [...values, option.value] : values.filter((value) => value !== option.value))}
          >
            <OptionIcon filter={filter.key} option={option} />
            <span className="min-w-0 flex-1 truncate">{label(option)}</span>
            <span className="text-xs tabular-nums text-ink-3">{option.count}</span>
            {values.includes(option.value) ? <Check className="!text-signal" /> : <span className="size-4 shrink-0" />}
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function useDebouncedText(value: string, onCommit: (next: string) => void) {
  const [text, setText] = useState(value)
  const commit = useRef(onCommit)
  commit.current = onCommit
  const committed = useRef(value)
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value
      setText(value)
    }
  }, [value])
  useEffect(() => {
    if (text === committed.current) return
    const timer = setTimeout(() => {
      // Clear may have got the URL there first, and writing it again would undo whatever was clicked since.
      if (text === committed.current) return
      committed.current = text
      commit.current(text)
    }, 250)
    return () => clearTimeout(timer)
  }, [text])
  return [text, setText] as const
}

function TextFilter({ filter, value, onChange }: { filter: IssueFilterDto; value: string; onChange: (value: string) => void }) {
  const [text, setText] = useDebouncedText(value, onChange)
  return (
    <Popover.Root>
      <Popover.Trigger className={triggerStyle} data-active={Boolean(value)}>
        {filter.label}
        {value ? <span className="max-w-24 truncate text-signal">{value}</span> : null}
        <ChevronDown className="size-3 text-ink-3" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 w-64 rounded-lg border border-divider bg-surface p-2 shadow-overlay">
          <Input
            autoFocus
            value={text}
            placeholder={`${filter.label} contains`}
            aria-label={`${filter.label} contains`}
            onChange={(event) => setText(event.target.value)}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function SortMenu({
  sorts,
  sort,
  direction,
  onSort,
}: {
  sorts: IssueSortDto[]
  sort: IssueSort
  direction: IssueSortDirection
  onSort: (sort: IssueSort, direction?: IssueSortDirection) => void
}) {
  const current = sorts.find((item) => item.key === sort)
  const Arrow = direction === 'asc' ? ArrowUp : ArrowDown
  const description = current ? `Sorted by ${current.label.toLowerCase()}, ${current[direction].toLowerCase()}` : 'Sort'
  const keepOpen = (event: Event) => event.preventDefault()
  return (
    <Menu>
      <Tooltip label={description} hoverOnly>
        <MenuTrigger
          className={cn(triggerStyle, 'ml-auto')}
          aria-label={description}
          data-active={sort !== 'updated' || direction !== ISSUE_SORTS.updated}
        >
          <Arrow className="size-3" />
          Sort: {current?.label ?? 'Updated'}
          <ChevronDown className="size-3 text-ink-3" />
        </MenuTrigger>
      </Tooltip>
      <MenuContent className="w-52" align="end">
        <MenuLabel>Sort by</MenuLabel>
        <MenuRadioGroup value={sort} onValueChange={(value) => onSort(value as IssueSort)}>
          {sorts.map((item) => (
            <MenuRadioItem key={item.key} value={item.key} onSelect={keepOpen}>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.key === sort ? <Check className="!text-signal" /> : null}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {current ? (
          <>
            <MenuSeparator />
            <MenuLabel>Order</MenuLabel>
            <MenuRadioGroup value={direction} onValueChange={(value) => onSort(sort, value as IssueSortDirection)}>
              {[ISSUE_SORTS[sort], ISSUE_SORTS[sort] === 'asc' ? ('desc' as const) : ('asc' as const)].map((item) => (
                <MenuRadioItem key={item} value={item} onSelect={keepOpen}>
                  <span className="min-w-0 flex-1 truncate">{current[item]}</span>
                  {item === direction ? <Check className="!text-signal" /> : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  )
}

export function IssueToolbar({
  projectId,
  scope,
  onScope,
  sort,
  direction,
  onSort,
  query,
  update,
  clear,
  active,
  placeholder,
}: {
  projectId?: string
  scope: IssueScope
  onScope: (scope: IssueScope) => void
  sort: IssueSort
  direction: IssueSortDirection
  onSort: (sort: IssueSort, direction?: IssueSortDirection) => void
  query: Record<string, string[]>
  update: (patch: Record<string, string[]>) => void
  clear: () => void
  active: boolean
  placeholder: string
}) {
  const { data } = useIssueFilterSpecs(projectId, scope)
  const [search, setSearch] = useDebouncedText(query.q?.[0] ?? '', (next) => update({ q: next ? [next] : [] }))
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-divider px-4 py-2">
      <ScopeSwitch scope={scope} onChange={onScope} />
      <label className="relative mr-1 flex w-full items-center sm:w-56">
        <Search className="pointer-events-none absolute left-2 size-3.5 text-ink-3" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-7 w-full rounded-sm border border-field bg-transparent pr-2 pl-7 text-xs outline-none transition-colors duration-100 placeholder:text-ink-3 focus:border-signal"
        />
      </label>
      {data?.filters.map((filter) =>
        filter.kind === 'text' ? (
          <TextFilter
            key={filter.key}
            filter={filter}
            value={query[filter.key]?.[0] ?? ''}
            onChange={(next) => update({ [filter.key]: next ? [next] : [] })}
          />
        ) : (
          <MultiFilter key={filter.key} filter={filter} values={query[filter.key] ?? []} onChange={(values) => update({ [filter.key]: values })} />
        ),
      )}
      {active ? (
        <button
          type="button"
          onClick={() => {
            setSearch('')
            clear()
          }}
          className="flex h-7 items-center gap-1 rounded-sm px-2 text-xs text-ink-2 transition-colors duration-100 hover:bg-soft hover:text-ink"
        >
          <X className="size-3" />
          Clear
        </button>
      ) : null}
      {data && data.sorts.length > 0 ? <SortMenu sorts={data.sorts} sort={sort} direction={direction} onSort={onSort} /> : null}
    </div>
  )
}

export function IssuePager({ list, onPage, className }: { list: IssueListDto; onPage: (page: number) => void; className?: string }) {
  const last = Math.max(1, Math.ceil(list.total / list.limit))
  useEffect(() => {
    if (list.page > last) onPage(last)
  }, [list.page, last, onPage])
  if (list.total <= list.limit) return null
  const first = (list.page - 1) * list.limit + 1
  return (
    <div className={cn('flex h-10 shrink-0 items-center justify-end gap-2 border-t border-divider px-4 text-xs text-ink-2', className)}>
      <span>
        {first}-{Math.min(first + list.limit - 1, list.total)} of {list.total}
      </span>
      <Button size="icon" variant="ghost" aria-label="Previous page" disabled={list.page <= 1} onClick={() => onPage(list.page - 1)}>
        <ChevronLeft />
      </Button>
      <Button size="icon" variant="ghost" aria-label="Next page" disabled={list.page >= last} onClick={() => onPage(list.page + 1)}>
        <ChevronRight />
      </Button>
    </div>
  )
}
