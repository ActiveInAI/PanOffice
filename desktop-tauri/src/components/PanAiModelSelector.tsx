import { useEffect, useState } from 'react'
import { isHostedByEflow } from '../bridge/eflow-ai'
import {
  loadBrowserPanAiModelCatalog,
  PANAI_MODEL_CHANGE_EVENT,
  selectedPanAiModel,
  setSelectedPanAiModel,
  type PanAiModelOption,
} from '../bridge/panai-models'

export function PanAiModelSelector(): React.JSX.Element {
  const [options, setOptions] = useState<PanAiModelOption[]>([])
  const [selected, setSelected] = useState('')

  useEffect(() => {
    let active = true
    void loadBrowserPanAiModelCatalog(isHostedByEflow()).then((catalog) => {
      if (!active) return
      setOptions(catalog)
      setSelected(selectedPanAiModel(catalog).id)
    })
    const onChange = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (typeof id === 'string') setSelected(id)
    }
    window.addEventListener(PANAI_MODEL_CHANGE_EVENT, onChange)
    return () => {
      active = false
      window.removeEventListener(PANAI_MODEL_CHANGE_EVENT, onChange)
    }
  }, [])

  return (
    <select
      value={selected}
      aria-label="选择 PanAI 模型"
      title="切换 PanAI 模型"
      data-testid="panai-model-selector"
      onChange={(event) => {
        const id = event.target.value
        setSelected(id)
        setSelectedPanAiModel(id)
      }}
      style={{
        height: 24,
        maxWidth: 142,
        padding: '0 22px 0 7px',
        border: '1px solid #d9dde5',
        borderRadius: 6,
        background: '#fff',
        color: '#3c414a',
        fontSize: 11,
        lineHeight: '22px',
        cursor: 'pointer',
      }}
    >
      {options.length === 0 ? <option value="">PanAI</option> : null}
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
