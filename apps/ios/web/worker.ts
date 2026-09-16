import { host } from './worker-bridge';
import { installFetch } from './fetch';
installFetch(args=>host('fetch',args), requestID=>{ void host('fetch-cancel',{requestID}); });
import '../../../src/core/compute/worker-entry';
