'use strict';

// REST transform — runs on the request/response stream of the REST API.
// Invoke with: ?transform=identity (custom transform args use trans: prefix)
function transform(context, params, content) {
  return content;
}

exports.transform = transform;
