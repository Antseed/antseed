import type {JSX} from 'react';
import {Section} from '../../components';
import {CompareTable, type CompareColumn} from '../../parts/CompareTable';
import {ROWS} from './rows';

const COLUMNS: readonly CompareColumn[] = [{label: 'Antseed', good: true}, {label: 'OpenRouter'}];

/** Antseed and OpenRouter, dimension by dimension. */
export default function Comparison(): JSX.Element {
  return (
    <Section cmp="vs-openrouter/compare" label="Antseed compared with OpenRouter" pad="all">
      <CompareTable columns={COLUMNS} rows={ROWS} rowsLabel="Dimension" />
    </Section>
  );
}
