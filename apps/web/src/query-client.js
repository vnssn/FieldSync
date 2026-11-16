import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';

function handleSessionFailure(error) {
  if (error.status === 401) queryClient.setQueryData(['session'], null);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleSessionFailure }),
  mutationCache: new MutationCache({ onError: handleSessionFailure }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } },
});
