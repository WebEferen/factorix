'use client'

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as placeholderText } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { cn } from '@/modules/lib/format'

export interface EditorIssue {
  line: number | null
  message: string
}

const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--link)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ink)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning-ink)' },
  { tag: tags.comment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], color: 'var(--ink-2)' },
  { tag: [tags.labelName, tags.meta, tags.typeName], color: 'var(--ink-2)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--surface)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--ink)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--softer)', color: 'var(--ink-3)', border: 'none', borderRight: '1px solid var(--divider)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--soft) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--soft)', color: 'var(--ink-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selected) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--soft)', outline: '1px solid var(--field)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--divider)', borderRadius: '6px', boxShadow: 'var(--lift-overlay)' },
  '.cm-diagnostic': { fontFamily: 'var(--font-sans)', fontSize: '12px', padding: '4px 8px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
  '.cm-placeholder': { color: 'var(--ink-3)' },
})

function diagnostics(state: EditorState, issues: EditorIssue[]): Diagnostic[] {
  return issues.map((issue) => {
    const line = state.doc.line(Math.min(Math.max(issue.line ?? 1, 1), state.doc.lines))
    const indent = line.text.length - line.text.trimStart().length
    return { from: line.from + indent, to: Math.max(line.to, line.from + indent), severity: 'error', message: issue.message }
  })
}

/** CodeMirror owns the text while it is mounted. A new `value` from outside, such as an example, replaces it. */
export function YamlEditor({
  value,
  onChange,
  issues,
  readOnly,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  issues: EditorIssue[]
  readOnly?: boolean
  placeholder?: string
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const editable = useRef(new Compartment())
  const latest = useRef(onChange)
  latest.current = onChange

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once and fed through the effects below
  useEffect(() => {
    if (!host.current) return
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          bracketMatching(),
          yaml(),
          syntaxHighlighting(highlight),
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorState.tabSize.of(2),
          placeholderText(placeholder ?? ''),
          editable.current.of([EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current(update.state.doc.toString())
          }),
          theme,
        ],
      }),
    })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    const current = view.current
    if (!current || current.state.doc.toString() === value) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly)]),
    })
  }, [readOnly])

  useEffect(() => {
    const current = view.current
    if (current) current.dispatch(setDiagnostics(current.state, diagnostics(current.state, issues)))
  }, [issues])

  return <div ref={host} className={cn('min-h-0 overflow-hidden rounded-md border border-field bg-surface', className)} />
}
