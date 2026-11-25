import type {PrismTheme} from 'prism-react-renderer';

/* Syntax colours for docs code blocks, one theme per site theme. The background is transparent: the block's surface comes from
   --as-code-block-bg in custom.css, so it follows the site tokens. Keywords take the site's green, strings and numbers a warm clay. */

const prismLight: PrismTheme = {
  plain: {color: '#30382c', backgroundColor: 'transparent'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#7d8a80', fontStyle: 'italic'}},
    {types: ['punctuation', 'operator'], style: {color: '#66746b'}},
    {types: ['keyword', 'builtin', 'important', 'atrule'], style: {color: '#4f7a24'}},
    {types: ['function', 'class-name'], style: {color: '#2f6f6a'}},
    {types: ['string', 'char', 'attr-value', 'regex', 'url'], style: {color: '#9a5b13'}},
    {types: ['number', 'boolean', 'constant', 'symbol'], style: {color: '#a8471c'}},
    {types: ['property', 'attr-name', 'tag', 'selector'], style: {color: '#436a1e'}},
    {types: ['variable', 'parameter'], style: {color: '#30382c'}},
    {types: ['deleted'], style: {color: '#b8392f'}},
    {types: ['inserted'], style: {color: '#4f7a24'}},
  ],
};

const prismDark: PrismTheme = {
  plain: {color: '#dfe3dc', backgroundColor: 'transparent'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#7f8984', fontStyle: 'italic'}},
    {types: ['punctuation', 'operator'], style: {color: '#9ba49e'}},
    {types: ['keyword', 'builtin', 'important', 'atrule'], style: {color: '#98c463'}},
    {types: ['function', 'class-name'], style: {color: '#8fcfc6'}},
    {types: ['string', 'char', 'attr-value', 'regex', 'url'], style: {color: '#e3b56f'}},
    {types: ['number', 'boolean', 'constant', 'symbol'], style: {color: '#ef9f6c'}},
    {types: ['property', 'attr-name', 'tag', 'selector'], style: {color: '#b0d184'}},
    {types: ['variable', 'parameter'], style: {color: '#dfe3dc'}},
    {types: ['deleted'], style: {color: '#e0766c'}},
    {types: ['inserted'], style: {color: '#98c463'}},
  ],
};

export {prismLight, prismDark};
