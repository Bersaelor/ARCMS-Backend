/*jslint node: true */

'use strict';

const fetch = require('node-fetch');

exports.fetchCoordinates = async (store) => {
    const address = encodeURI(`${store.address} ${store.zipCode} ${store.city}`)
	const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?key=${process.env.GOOGLE_KEY}&address=${address}`,
        {method: 'GET'});
	const json = await response.json();
    if (json && json.results && json.results.length > 0 && json.results[0].geometry && json.results[0].geometry.location) {
        return json.results[0].geometry.location
    } else {
        console.log(`No location found for:`, store.sk)
        return undefined
    }
}
