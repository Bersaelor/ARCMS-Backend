'use strict';

exports.cloudfront = (event, context, callback) => {
    const request = event.Records[0].cf.request;

    if (request.uri == "/loocfun/a" || request.uri.startsWith('/loocfun/a?')) {
        request.uri = '/loocfun/app.html' + request.querystring;
        //Generate HTTP redirect response to a different landing page.
        const redirectResponse = {
            status: '301',
            statusDescription: 'Moved Permanently',
            headers: {
                'location': [{
                    key: 'Location',
                    value: '/loocfun/app.html?' + request.querystring,
                }],
                'cache-control': [{
                    key: 'Cache-Control',
                    value: "max-age=3600"
                }],
            },
        };
        callback(null, redirectResponse);
    } else {
        callback(null, request);
    }
};
