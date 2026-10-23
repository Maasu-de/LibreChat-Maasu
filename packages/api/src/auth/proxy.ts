import { getOpenIdProxyDispatcher } from '~/utils/proxy';

export { getOpenIdProxyDispatcher } from '~/utils/proxy';

export function fetchOpenId(url: string | URL, options?: RequestInit): Promise<Response> {
  const fetchOptions = { ...options, dispatcher: getOpenIdProxyDispatcher() };
  return fetch(url, fetchOptions);
}
