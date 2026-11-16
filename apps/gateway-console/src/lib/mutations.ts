import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useToast } from '@antseed/ui'
import { CANCELLED } from './policy-save'

type Done<T> = Exclude<T, typeof CANCELLED>

interface ConsoleMutationOptions<TData, TVariables> {
  mutationFn: (variables: TVariables) => Promise<TData>
  /** Runs first after a successful write, e.g. to close the dialog that started it. */
  onSuccess?: (data: Done<TData>, variables: TVariables) => void
  /** Query keys (or key prefixes, like `qk.group('keys')`) to refetch after a successful write. */
  invalidate?: readonly QueryKey[]
  /** Toast after a successful write; a function may return null for none. */
  toast?: string | ((data: Done<TData>, variables: TVariables) => string | null)
  onError?: (error: Error, variables: TVariables) => void
}

/**
 * A console write: on success it runs `onSuccess`, refetches `invalidate`
 * and shows `toast`. A guarded policy save the user backed out of
 * (`CANCELLED`) counts as nothing happening.
 */
export function useConsoleMutation<TData, TVariables = void>(options: ConsoleMutationOptions<TData, TVariables>) {
  const queryClient = useQueryClient()
  const toast = useToast()
  return useMutation<TData, Error, TVariables>({
    mutationFn: options.mutationFn,
    onSuccess: (data, variables) => {
      if (data === CANCELLED) return
      const done = data as Done<TData>
      options.onSuccess?.(done, variables)
      for (const queryKey of options.invalidate ?? []) void queryClient.invalidateQueries({ queryKey })
      const message = typeof options.toast === 'function' ? options.toast(done, variables) : options.toast
      if (message) toast(message)
    },
    onError: options.onError,
  })
}
