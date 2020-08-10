/*jslint node: true */

'use strict';

exports.paginate = (items, perPage, LastEvaluatedKey) => {
    if (LastEvaluatedKey) {
        const base64Key = Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64')
        return {
            items: items,
            itemCount: items.length,
            fullPage: perPage,
            hasMoreContent: LastEvaluatedKey !== undefined,
            nextPageKey: base64Key 
        }
    } else {
        return {
            items: items,
            itemCount: items.length,
            fullPage: perPage,
            hasMoreContent: false,
        }
    }
}