'use strict';


exports.get = async function(event, context, callback){

    console.log("Event: ", event);

    const response = {
        statusCode: 200,
        headers: {
            "x-custom-header" : "My Header Value"
        },
    body: JSON.stringify({ 
            message: "Hello World!",
            input: event
        })
    };

    callback(null, response);
}
