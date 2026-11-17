import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { expireSession } from './offline/session.js';

function handleSessionFailure(error) {
  if (error.status === 401) expireSession();
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleSessionFailure }),
  mutationCache: new MutationCache({ onError: handleSessionFailure }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } },
});
