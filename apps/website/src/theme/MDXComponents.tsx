import MDXComponents from '@theme-original/MDXComponents';
import {CommandTable, CommandTableRow} from '@site/src/components/CommandTable';

export default {
  ...MDXComponents,
  CommandTable,
  tr: CommandTableRow,
};
