import type {PrismTheme} from 'prism-react-renderer';

/* Syntax colors for docs code blocks, drawn from the emerald ramp plus the
   clay accent (strings/numbers) so code sits on the brand void surface. */
const prismTheme: PrismTheme = {
  plain: {
    color: '#DCF7EE',
    backgroundColor: '#02150C',
  },
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#6E8F80', fontStyle: 'italic'}},
    {types: ['punctuation', 'operator'], style: {color: '#98B5A8'}},
    {types: ['keyword', 'builtin', 'important', 'atrule'], style: {color: '#3DC799'}},
    {types: ['function', 'class-name'], style: {color: '#98E2CA'}},
    {types: ['string', 'char', 'attr-value', 'regex', 'url'], style: {color: '#E8C07A'}},
    {types: ['number', 'boolean', 'constant', 'symbol'], style: {color: '#F0A868'}},
    {types: ['property', 'attr-name', 'tag', 'selector'], style: {color: '#6BD5B1'}},
    {types: ['variable', 'parameter'], style: {color: '#C6F0E2'}},
    {types: ['deleted'], style: {color: '#F08A8A'}},
    {types: ['inserted'], style: {color: '#6BD5B1'}},
  ],
};

export default prismTheme;
