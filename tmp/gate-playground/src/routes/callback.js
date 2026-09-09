const { buildCallbackResponse } = require('../auth/oauth');
function callbackRoute() { return buildCallbackResponse(); }
module.exports = { callbackRoute };
