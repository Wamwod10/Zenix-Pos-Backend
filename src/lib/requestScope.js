import {AsyncLocalStorage} from 'node:async_hooks';

// Async-local, never process-global: concurrent tenant requests cannot share scope.
export const requestScope=new AsyncLocalStorage();
