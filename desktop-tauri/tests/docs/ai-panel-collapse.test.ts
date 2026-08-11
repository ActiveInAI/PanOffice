// The AI panel stays mounted while collapsed but renders no residual rail,
// so the draft and in-flight state survive without consuming canvas width.
import { beforeAll, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/apps/docs/renderer/editor/extensions'
import { AiPanel } from '../../src/apps/docs/renderer/ai/AiPanel'
import { AI_PROVIDERS, type AiSettings } from '../../src/apps/docs/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [p.id, { apiKey: '', model: p.defaultModel }]),
  ) as AiSettings['providers'],
}

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: 0 },
          content: [{ type: 'text', text: 'EVs market research' }],
        },
      ],
    },
  })
}

function mount(element: React.ReactElement): {
  container: HTMLElement
  root: Root
  cleanup: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function panelProps(editor: Editor, overrides: Record<string, unknown> = {}) {
  return {
    editor,
    blocks: [],
    settings,
    open: true,
    ...overrides,
  }
}

/** Simulate typing into React's controlled textarea */
function typeInto(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(() => {
  // jsdom has no scrollTo; the panel auto-scrolls its chat log
  Element.prototype.scrollTo ??= () => {}
})

describe('AiPanel collapse', () => {
  it('keeps the draft input across a collapse/expand cycle', () => {
    const editor = createEditor()
    const { container, root, cleanup } = mount(createElement(AiPanel, panelProps(editor)))

    const textarea = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')
    expect(textarea).not.toBeNull()
    typeInto(textarea!, 'unsent draft')
    expect(textarea!.value).toBe('unsent draft')

    // collapse: no panel chrome or rail is rendered, but the component stays mounted
    act(() => root.render(createElement(AiPanel, panelProps(editor, { open: false }))))
    expect(container.querySelector('.ai-input-box textarea')).toBeNull()
    expect(container.querySelector('.ai-rail')).toBeNull()
    expect(container.querySelector('[data-testid="panai-panel"]')).toBeNull()

    // expand: the draft is still there
    act(() => root.render(createElement(AiPanel, panelProps(editor, { open: true }))))
    const restored = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')
    expect(restored).not.toBeNull()
    expect(restored!.value).toBe('unsent draft')

    cleanup()
    editor.destroy()
  })

  it('leaves no width-consuming rail while closed', () => {
    const editor = createEditor()
    const { container, cleanup } = mount(
      createElement(AiPanel, panelProps(editor, { open: false })),
    )

    expect(container.querySelector('.ai-rail')).toBeNull()
    expect(container.querySelector('[data-testid="panai-panel"]')).toBeNull()
    expect(container.childElementCount).toBe(0)

    cleanup()
    editor.destroy()
  })
})
