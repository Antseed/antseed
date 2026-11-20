import type {JSX} from 'react';
import {Faq} from '../../parts/Faq';
import {HOME_QUESTIONS} from './faq/questions';

export default function HomeFaq(): JSX.Element {
  return <Faq cmp="home/faq" items={HOME_QUESTIONS} />;
}
