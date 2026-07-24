'use strict';

// REST resource extension deployed to /v1/resources/echo by mlLoadModules.
// Custom params MUST be invoked with the "rs:" prefix from the client side, e.g.
//   GET /v1/resources/echo?rs:text=hello
// Without the prefix MarkLogic returns
//   REST-UNSUPPORTEDPARAM: invalid parameters: text for echo
// (The accompanying services/metadata/echo.xml file declares title, description,
//  and parameter docs — those declarations are advisory; the rs: prefix is still
//  enforced at runtime regardless.)
function get(context, params) {
  const text = params['rs:text'] || 'hello from ml-gradle';
  return { ok: true, echoed: text, host: xdmp.host() };
}

exports.GET = get;
