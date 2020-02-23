
var makerjs_1 = {}
var xml2js_1 = {}
makerjs_1.default = require('makerjs');
xml2js_1.default = require('xml2js');

// unfortunately dxf has no types
const { Helper, entityToBoundsAndElement, colors } = require('dxf');
const tol = 0.0001;
const minPadX = 0.2;
var rgbToHex = function (rgb) {
    var hex = Number(rgb).toString(16);
    if (hex.length < 2) {
        hex = "0" + hex;
    }
    return hex;
};
function rgbToColorAttribute(rgb) {
    if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) {
        return '#000000)';
    }
    else {
        return `#${rgbToHex(rgb[0])}${rgbToHex(rgb[1])}${rgbToHex(rgb[2])}`;
    }
}
function categorize(entities) {
    var textsByColor = {};
    var entitiesByColor = {};
    entities.forEach(entity => {
        if (entity.type === "MTEXT") {
            let existing = textsByColor[entity.colorNumber];
            if (existing) {
                existing.push(entity.string);
            }
            else {
                textsByColor[entity.colorNumber] = Array(entity.string);
            }
        }
        else {
            let existing = entitiesByColor[entity.colorNumber];
            if (existing) {
                existing.push(entity);
            }
            else {
                entitiesByColor[entity.colorNumber] = Array(entity);
            }
        }
    });
    return { textsByColor: textsByColor, entitiesByColor: entitiesByColor };
}
function checkForDuplicates(textsByColor) {
    let duplicateKey = Object.keys(textsByColor).find(key => textsByColor[key].length > 1);
    return duplicateKey ? textsByColor[duplicateKey].map(t => `"${t}"`) : [];
}
function modelFromPaths(paths) {
    let makerobjects = paths.map(pathData => {
        const pathModel = makerjs_1.default.importer.fromSVGPathData(pathData);
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        const mirroredModel = makerjs_1.default.model.mirror(pathModel, false, true);
        makerjs_1.default.model.originate(mirroredModel);
        makerjs_1.default.model.simplify(mirroredModel);
        return mirroredModel;
    });
    let obj = makerobjects.reduce((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});
    let model = { models: obj };
    return model;
}
function modelFromCircles(circles) {
    let circlePaths = circles.map(circle => {
        let radius = parseFloat(circle.$.r);
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        let center = [parseFloat(circle.$.cx), parseFloat(circle.$.cy)];
        return new makerjs_1.default.paths.Circle(center, radius);
    });
    let pathMap = circlePaths.reduce((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});
    return { paths: pathMap };
}
function createParts(textsByColor, entitiesByColor, svgObj, warnings) {
    var objectsByColor = {};
    Object.keys(entitiesByColor).forEach(color => {
        let paths = entitiesByColor[color].map(entity => {
            const { element } = entityToBoundsAndElement(entity);
            if (element.startsWith("<path d=") && element.endsWith(" />")) {
                let length = element.length;
                return element.substring(9, length - 9 - 5);
            }
            else {
                console.log(`entity ${entity.type} lead to an unusable svg of `, element);
                return undefined;
            }
        });
        objectsByColor[color] = modelFromPaths(paths);
    });
    let partNames = {
        bridge: ["bridge", "bruecke", "brücke"],
        shape: ["shape", "front", "frame", "shape_left", "shape_right"],
        hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
        pad: ["pad", "pad_left", "pad_right"]
    };
    var parts = {};
    Object.keys(partNames).forEach(part => {
        let names = partNames[part];
        let color = Object.keys(textsByColor).find(color => {
            let texts = textsByColor[color];
            return texts.find(text => names.includes(text.toLowerCase())) !== undefined;
        });
        if (!color) {
            warnings.push({ term: "frameupload.dxfwarning.missingAnnotation", data: { NAME: part } });
        }
        else {
            let object = objectsByColor[color];
            if (!object) {
                warnings.push({ term: "frameupload.dxfwarning.missingCurve", data: { NAME: part } });
            }
            else {
                if (svgObj && svgObj.svg && svgObj.svg.g.length > 0 && svgObj.svg.g[0].path) {
                    let firstGroup = svgObj.svg.g[0];
                    let paths = firstGroup.path;
                    let rgb = rgbToColorAttribute(colors[color]);
                    let matchingPaths = paths.filter(path => path.$ && path.$.style.startsWith && path.$.style.startsWith(`stroke:${rgb}`));
                    if (matchingPaths.length > 0) {
                        parts[part] = modelFromPaths(matchingPaths.map(path => path.$.d));
                    }
                    if (firstGroup.circle && firstGroup.circle.length > 0) {
                        let colorFittingCircles = firstGroup.circle.filter(c => c.$.style.startsWith(`stroke:${rgb}`));
                        if (part === "shape") {
                            parts[`${part}_holes`] = modelFromCircles(colorFittingCircles);
                        }
                        else {
                            console.log(`Unhandled circles for ${part}: `, firstGroup.circle);
                        }
                    }
                }
            }
        }
    });
    return parts;
}
/**
 * analyzes the dxfContents and creates a preview SVG for viewing of the uploaded
 * the converted SVG isn't very high quality, so before we can use maker.js to really work on it
 * we need to upload the file to the cloud to properly convert it to a higher quality svg
 *
 * @param dxfContents the uploaded original DXF file contents
 * @param svgContents the contents of the high quality svg converted in the cloud
 */
async function analyzeDXF(dxfContents, svgContents) {
    const helper = new Helper(dxfContents);
    const previewSVG = helper.toSVG();
    var warnings = [];
    var { textsByColor, entitiesByColor } = categorize(helper.denormalised);
    let duplicates = checkForDuplicates(textsByColor);
    if (duplicates && duplicates.length > 0) {
        warnings.push({ term: "frameupload.dxfwarning.duplicate", data: { DUPLICATES: checkForDuplicates(textsByColor).join(" & ") } });
    }
    var svgObj;
    if (svgContents) {
        let parser = new xml2js_1.default.Parser();
        svgObj = await parser.parseStringPromise(svgContents);
    }
    // create the parts just to make the warnings
    createParts(textsByColor, entitiesByColor, svgObj, warnings);
    return { previewSVG: previewSVG, warnings: warnings };
}
exports.analyzeDXF = analyzeDXF;
async function makeModelParts(dxfContents, svgContents) {
    const helper = new Helper(dxfContents);
    const { textsByColor, entitiesByColor } = categorize(helper.denormalised);
    const parser = new xml2js_1.default.Parser();
    const svgObj = await parser.parseStringPromise(svgContents);
    const parts = createParts(textsByColor, entitiesByColor, svgObj, []);
    const options = {
        pointMatchingDistance: 0.05,
        shallow: false,
        unifyBeziers: true
    };
    var convertedParts = {};
    Object.keys(parts).forEach(key => {
        const part = parts[key];
        const chains = makerjs_1.default.model.findChains(part, options);
        if (chains.length === 1) {
            let model = makerjs_1.default.chain.toNewModel(chains[0], true);
            convertedParts[key] = model;
        }
        else if (chains.length > 1) {
            var modelMap = {};
            chains.forEach((element, index) => {
                modelMap[`${key}-${index}`] = makerjs_1.default.chain.toNewModel(element, true);
            });
            convertedParts[key] = { models: modelMap };
        }
    });
    let bridgeMeas = makerjs_1.default.measure.modelExtents(convertedParts.bridge);
    let hingeMeas = makerjs_1.default.measure.modelExtents(convertedParts.hinge);
    let isLeftSide = hingeMeas.high[0] < bridgeMeas.low[0];
    // move combined model to have origin [0, 0]
    let fullMeas = makerjs_1.default.measure.modelExtents({ models: convertedParts });
    let combined = { models: convertedParts, origin: makerjs_1.default.point.scale(fullMeas.low, -1) };
    makerjs_1.default.model.originate(combined);
    makerjs_1.default.model.zero(combined);
    if (isLeftSide) {
        // mirror the parts so the bridge is the part that starts at 0
        Object.keys(combined.models).forEach(key => {
            const model = combined.models[key];
            combined.models[key] = makerjs_1.default.model.distort(model, -1, 1);
        });
        makerjs_1.default.model.zero(combined);
        makerjs_1.default.model.originate(combined);
    }
    // move down so the vertical center line is 0
    let newBridgeMeas = makerjs_1.default.measure.modelExtents(combined.models.bridge);
    makerjs_1.default.model.moveRelative(combined, [0, -newBridgeMeas.center[1]]);
    makerjs_1.default.model.originate(combined);
    return combined.models;
}
exports.makeModelParts = makeModelParts;
function convertToChained(model) {
    const options = {
        pointMatchingDistance: 0.05,
        shallow: false,
        unifyBeziers: false
    };
    const chains = makerjs_1.default.model.findChains(model, options);
    console.log("chains: ", chains);
    var chainedParts = {};
    chains.forEach((element, index) => {
        chainedParts[`chain_${index}`] = makerjs_1.default.chain.toNewModel(element, true);
    });
    return { models: chainedParts };
}
function findConnectingLine(shape, pad) {
    // find the connection line in the shape
    let padTop = makerjs_1.default.measure.modelExtents(pad).high[1];
    var linesConnectedToTop = [];
    var findInShapeWalk = {
        onPath: function (wp) {
            if (makerjs_1.default.isPathLine(wp.pathContext)) {
                let line = wp.pathContext;
                let distToTop = Math.min(Math.abs(padTop - line.origin[1]), Math.abs(padTop - line.end[1]));
                if (distToTop < tol)
                    linesConnectedToTop.push({ line: line, route: wp.route });
            }
        }
    };
    makerjs_1.default.model.walk(shape, findInShapeWalk);
    if (linesConnectedToTop.length !== 1) {
        console.log("ERROR: Expected a single line in the Shape part that connects to the Pad, found ", linesConnectedToTop.length);
        return undefined;
    }
    let lineInShape = linesConnectedToTop[0];
    let topPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.origin : lineInShape.line.end;
    let bottomPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.end : lineInShape.line.origin;
    // find the lines that connect to the lineInShape in the pad
    linesConnectedToTop = [];
    var linesConnectedToBottom = [];
    var findLinesInPad = {
        onPath: function (wp) {
            if (makerjs_1.default.isPathLine(wp.pathContext)) {
                let line = wp.pathContext;
                let originToTop = makerjs_1.default.measure.pointDistance(topPoint, line.origin);
                let endTopTop = makerjs_1.default.measure.pointDistance(topPoint, line.end);
                let distToTop = Math.min(originToTop, endTopTop);
                let originToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, line.origin);
                let endToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, line.end);
                let distToBottom = Math.min(originToBottom, endToBottom);
                if (distToTop < tol)
                    linesConnectedToTop.push({
                        line: line, route: wp.route, isAtOrigin: originToTop < endTopTop
                    });
                if (distToBottom < tol)
                    linesConnectedToBottom.push({
                        line: line, route: wp.route, isAtOrigin: originToBottom < endToBottom
                    });
            }
        }
    };
    makerjs_1.default.model.walk(pad, findLinesInPad);
    return { lineInShape: lineInShape, padLinesTop: linesConnectedToTop, padLinesBottom: linesConnectedToBottom };
}
function clone(model) {
    return makerjs_1.default.cloneObject(model);
}
function lineInModel(model, lineInfo) {
    var runner = model;
    lineInfo.route.forEach(routeKey => {
        runner = runner[routeKey];
    });
    if (makerjs_1.default.isPathLine(runner)) {
        let line = runner;
        return line;
    }
    return undefined;
}
function setPointEqual(lineInfo, model, goalPoint) {
    let line = lineInModel(model, lineInfo);
    if (!line)
        return;
    if (lineInfo.isAtOrigin)
        line.origin = makerjs_1.default.point.clone(goalPoint);
    else
        line.end = makerjs_1.default.point.clone(goalPoint);
}
function combineModel(parts, bridgeSize, glasWidth, glasHeight, defaultSizes) {
    let m = makerjs_1.default.model;
    var t0 = performance.now();
    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    let shape = clone(parts.shape);
    let pad = clone(parts.pad);
    let hinge = parts.hinge;
    var bridge = parts.bridge;
    let connectingLines = findConnectingLine(shape, pad);
    let bridgeMeas = makerjs_1.default.measure.modelExtents(bridge);
    let shapeMeas = makerjs_1.default.measure.modelExtents(shape);
    let padMeas = makerjs_1.default.measure.modelExtents(pad);
    let padMin = padMeas.low[0];
    // the amount the rightmost point of the pad is reaching into the shape
    let padDelta = [padMeas.high[0] - shapeMeas.low[0], padMeas.high[1]];
    let bridgeFactor = 1 - (defaultSizes.bridgeSize - bridgeSize) / (2 * bridgeMeas.width);
    let bridgeXTranslation = (bridgeSize - defaultSizes.bridgeSize) / 2;
    let verticalFactor = glasHeight / defaultSizes.glasHeight;
    let horizontalFactor = glasWidth / defaultSizes.glasWidth;
    // scale bridge around center
    bridge = m.distort(bridge, bridgeFactor, verticalFactor);
    // scale shape and hinge around center of bridge
    m.moveRelative(shape, [-shapeMeas.low[0], 0]);
    m.originate(shape);
    // give it a little bit extra to overcome small glitches when combining
    const floatingPointSecFactor = 1.00003;
    shape = m.distort(shape, horizontalFactor * floatingPointSecFactor, verticalFactor);
    m.moveRelative(shape, [shapeMeas.low[0] - 0.5 * (floatingPointSecFactor - 1), 0]);
    hinge = m.distort(hinge, 1, verticalFactor);
    let hingeTranslation = shapeMeas.width * (horizontalFactor - 1);
    let padTranslation = [padDelta[0] * (horizontalFactor - 1), padDelta[1] * (verticalFactor - 1)];
    m.moveRelative(shape, [bridgeXTranslation, 0]);
    m.moveRelative(hinge, [bridgeXTranslation + hingeTranslation, 0]);
    var totalPadTranslation = makerjs_1.default.point.add([bridgeXTranslation, 0], padTranslation);
    let padDiff = padMin + totalPadTranslation[0] - minPadX;
    if (padDiff < 0) {
        totalPadTranslation[0] = minPadX - padMin;
        totalPadTranslation[1] = totalPadTranslation[1] - padDiff * 0.4;
    }
    m.moveRelative(pad, totalPadTranslation);
    // connect the pads to the shape on the connecting line
    m.originate({ models: { shape: shape, pad: pad } });
    if (connectingLines) {
        let shapeLine = lineInModel(shape, connectingLines.lineInShape);
        if (shapeLine) {
            let topPoint = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.origin : shapeLine.end;
            let bottomPoint = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.end : shapeLine.origin;
            connectingLines.padLinesTop.forEach(lineInfo => setPointEqual(lineInfo, pad, topPoint));
            connectingLines.padLinesBottom.forEach(lineInfo => setPointEqual(lineInfo, pad, bottomPoint));
        }
        else {
            console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!");
        }
    }
    else {
        console.log("ERROR: Failed to find line that connects Pad and Shape!");
    }
    if (parts.shape_holes) {
        let holes = clone(parts.shape_holes);
        // scale the hole positions the same way as the shape
        // basically what `holes = m.distort(holes, horizontalFactor, verticalFactor)` would do
        if (holes.models) {
            Object.keys(holes.models).forEach(key => {
                if (!holes.models)
                    return;
                let hole = holes.models[key];
                // we scale the shape from the lower end
                var center = makerjs_1.default.point.subtract(makerjs_1.default.measure.modelExtents(hole).center, [shapeMeas.low[0], 0]);
                let scaledCenter = [center[0] * horizontalFactor, center[1] * verticalFactor];
                let diff = makerjs_1.default.point.subtract(scaledCenter, center);
                m.moveRelative(hole, diff);
            });
        }
        m.moveRelative(holes, [bridgeXTranslation, 0]);
        shape = m.combineSubtraction(shape, holes);
    }
    // combine the shapes into glasses
    // let options = {pointMatchingDistance: 0.005}
    let bridgeAndShape = m.combine(bridge, shape, false, true, false, true);
    let bridgeShapeAndPads = m.combine(bridgeAndShape, pad, false, true, false, true);
    var fullSide = m.combine(bridgeShapeAndPads, hinge, false, true, false, true);
    let mirroredSide = m.mirror(fullSide, true, false);
    m.moveRelative(fullSide, [-0.0001, 0]);
    let fullFrame = m.combineUnion(fullSide, mirroredSide);
    var t1 = performance.now();
    console.log("Combining frame took " + (t1 - t0) + " ms.");
    return fullFrame;
}
exports.combineModel = combineModel;