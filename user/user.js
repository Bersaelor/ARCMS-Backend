'use strict';


exports.get = async function(event, context, callback){

    console.log("Event: ", event);

    var userParameter = event.queryStringParameters.user;

    const response = {
        statusCode: 200,
        headers: {
            "x-custom-header" : "My Header Value"
        },
    body: JSON.stringify({ 
            message: "Hello World!",
            input: userParameter
        })
    };

    callback(null, response);
}
