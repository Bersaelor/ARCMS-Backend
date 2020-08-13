/*jslint node: true */

'use strict';

exports.paginate = (items, perPage, LastEvaluatedKey) => {
    var result = {}
    if (LastEvaluatedKey) {
        const base64Key = Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64')
        result = {
            items: items,
            itemCount: items.length,
            hasMoreContent: LastEvaluatedKey !== undefined,
            nextPageKey: base64Key 
        }
    } else {
        result = {
            items: items,
            itemCount: items.length,
            hasMoreContent: false,
        }
    }
    if (perPage) result.fullPage = perPage
    return result
}