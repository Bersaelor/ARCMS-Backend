"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const makerjs_1 = __importDefault(require("makerjs"));
const xml2js_1 = __importDefault(require("xml2js"));
const tol = 0.0001;
const minPadX = 0.2;
const partNames = {
    bridge: ["bridge", "bruecke", "brücke"],
    shape: ["shape", "front", "frame", "shape_left", "shape_right"],
    hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
    pad: ["pad", "pad_left", "pad_right"]
};
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
function createParts(part2ColorMap, svgObj) {
    if (!svgObj || !svgObj.svg || svgObj.svg.g.length < 1 || !svgObj.svg.g[0].path) {
        console.log("SvgObj is missing key svg properties!");
        return {};
    }
    var parts = {};
    Object.keys(partNames).forEach(part => {
        let color = part2ColorMap[part];
        if (color) {
            let firstGroup = svgObj.svg.g[0];
            let paths = firstGroup.path;
            let matchingPaths = paths.filter(path => path.$ && path.$.style.startsWith && path.$.style.startsWith(`stroke:${color}`));
            if (matchingPaths.length > 0) {
                parts[part] = modelFromPaths(matchingPaths.map(path => path.$.d));
            }
            if (firstGroup.circle && firstGroup.circle.length > 0) {
                let colorFittingCircles = firstGroup.circle.filter(c => c.$.style.startsWith(`stroke:${color}`));
                if (part === "shape") {
                    parts[`${part}_holes`] = modelFromCircles(colorFittingCircles);
                }
                else {
                    console.log(`Unhandled circles for ${part}: `, firstGroup.circle);
                }
            }
        }
    });
    return parts;
}
async function makeModelParts(part2ColorMap, svgContents) {
    const parser = new xml2js_1.default.Parser();
    const svgObj = await parser.parseStringPromise(svgContents);
    const parts = createParts(part2ColorMap, svgObj);
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
function findConnectingLine(shape, pad) {
    var warnings = [];
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
        warnings.push({
            term: "frameupload.dxfwarning.unexpectedLineCountConnectingPadAndShape",
            data: { COUNT: linesConnectedToTop.length.toString() }
        });
        console.log("ERROR: Expected a single line in the Shape part that connects to the Pad, found ", linesConnectedToTop.length);
        return { connectingLines: undefined, warnings: warnings };
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
    return {
        connectingLines: { lineInShape: lineInShape, padLinesTop: linesConnectedToTop, padLinesBottom: linesConnectedToBottom },
        warnings: warnings
    };
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
    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    let shape = clone(parts.shape);
    let pad = clone(parts.pad);
    let hinge = parts.hinge;
    var bridge = parts.bridge;
    let { connectingLines, warnings } = findConnectingLine(shape, pad);
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
            warnings.push({ term: "frameupload.dxfwarning.noLineConnectsPadAndShape", data: {} });
            console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!");
        }
    }
    else {
        warnings.push({ term: "frameupload.dxfwarning.noLineConnectsPadAndShape", data: {} });
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
    return { model: fullFrame, warnings: warnings };
}
exports.combineModel = combineModel;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRFhGQW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJEWEZBbmFseXplci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLHNEQUF1RDtBQUN2RCxvREFBNEI7QUFFNUIsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFBO0FBQ2xCLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQTtBQUVuQixNQUFNLFNBQVMsR0FBK0I7SUFDMUMsTUFBTSxFQUFFLENBQUMsUUFBUSxFQUFFLFNBQVMsRUFBRSxRQUFRLENBQUM7SUFDdkMsS0FBSyxFQUFFLENBQUMsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsWUFBWSxFQUFFLGFBQWEsQ0FBQztJQUMvRCxLQUFLLEVBQUUsQ0FBQyxPQUFPLEVBQUUsWUFBWSxFQUFFLGFBQWEsRUFBRSxPQUFPLENBQUM7SUFDdEQsR0FBRyxFQUFFLENBQUMsS0FBSyxFQUFFLFVBQVUsRUFBRSxXQUFXLENBQUM7Q0FDeEMsQ0FBQTtBQW9DRCxTQUFTLGNBQWMsQ0FBQyxLQUFlO0lBQ25DLElBQUksWUFBWSxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLEVBQUU7UUFDcEMsTUFBTSxTQUFTLEdBQUcsaUJBQU8sQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxDQUFBO1FBQzVELG1GQUFtRjtRQUNuRixNQUFNLGFBQWEsR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsU0FBUyxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQTtRQUVsRSxpQkFBTyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsYUFBYSxDQUFDLENBQUE7UUFDdEMsaUJBQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFBO1FBQ3JDLE9BQU8sYUFBYSxDQUFBO0lBQ3hCLENBQUMsQ0FBQyxDQUFBO0lBQ0YsSUFBSSxHQUFHLEdBQUcsWUFBWSxDQUFDLE1BQU0sQ0FBWSxD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