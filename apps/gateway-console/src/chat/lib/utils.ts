import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class-name joiner, used by the AI Elements components under src/chat/components. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
