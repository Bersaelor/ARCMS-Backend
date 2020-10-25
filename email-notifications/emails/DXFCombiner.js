"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const makerjs_1 = __importDefault(require("makerjs"));
const xml2js_1 = __importDefault(require("xml2js"));
const tol = 0.01;
const minPadX = 0.2;
let m = makerjs_1.default.model;
let p = makerjs_1.default.point;
const partNames = {
    bridge: ["bridge", "bruecke", "brücke"],
    shape: ["shape", "front", "frame", "shape_left", "shape_right"],
    hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
    pad: ["pad", "pad_left", "pad_right"]
};
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
// helper functions
function origin(line) { return line.isAtOrigin ? line.line.origin : line.line.end; }
function end(line) { return line.isAtOrigin ? line.line.end : line.line.origin; }
function top(line) { return line.origin[1] > line.end[1] ? line.origin : line.end; }
function bottom(line) { return line.origin[1] > line.end[1] ? line.end : line.origin; }
function center(line) { return p.scale(p.add(line.origin, line.end), 0.5); }
function sameDirection(vecA, vecB) {
    let lowTol = 0.0001;
    if (vecA[1] < lowTol || vecB[1] < lowTol)
        return (vecA[1] < lowTol && vecB[1] < lowTol) && (Math.sign(vecA[0]) === Math.sign(vecB[0]));
    return vecA[0] / vecA[1] - vecB[0] / vecB[1] < lowTol;
}
function normSquared(vec) { return vec[0] * vec[0] + vec[1] * vec[1]; }
function modelFromPaths(paths) {
    let makerobjects = paths.map(pathData => {
        const pathModel = makerjs_1.default.importer.fromSVGPathData(pathData);
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        const mirroredModel = m.mirror(pathModel, false, true);
        m.originate(mirroredModel);
        m.simplify(mirroredModel);
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
    if (!svgObj || !svgObj.svg || svgObj.svg.g.length < 1 || !svgObj.svg.g[0]) {
        console.log("SvgObj is missing key svg properties!");
        return {};
    }
    let firstGroup = svgObj.svg.g[0];
    var parts = {};
    Object.keys(partNames).forEach(part => {
        let color = part2ColorMap[part];
        if (color) {
            let paths = firstGroup.path;
            const addMatching = (paths) => {
                if (paths.length > 0)
                    parts[part] = modelFromPaths(paths.map(path => path.$.d));
            };
            if (paths) {
                // the qcad converted svg from the cloud always has the all the paths in the array svgObj.svg.g[0].path
                let matchingPaths = paths.filter(path => path.$ && path.$.style.startsWith && path.$.style.startsWith(`stroke:${color}`));
                addMatching(matchingPaths);
                if (firstGroup.circle && firstGroup.circle.length > 0) {
                    let colorFittingCircles = firstGroup.circle.filter(c => c.$.style.startsWith(`stroke:${color}`));
                    if (part === "shape" || part === "hinge") {
                        parts[`${part}_holes`] = modelFromCircles(colorFittingCircles);
                    }
                    else {
                        console.log(`Unhandled circles for ${part}: `, firstGroup.circle);
                    }
                }
            }
            else if (firstGroup.g) {
                // the dxf-library browser converted previewSVG has a groups array in svgObj.svg.g[0].g each with one path
                firstGroup.g.forEach(group => {
                    if (group.$ && group.$.stroke) {
                        const rgbString = group.$.stroke.startsWith && group.$.stroke.startsWith('rgb(') && group.$.stroke.slice(4);
                        const hex = rgbString && rgbToColorAttribute(rgbString.split(",").map(v => parseInt(v)));
                        if (group.path && hex === color)
                            addMatching(group.path);
                    }
                });
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
        const chains = m.findChains(part, options);
        if (chains && chains.length === 1) {
            let model = makerjs_1.default.chain.toNewModel(chains[0], true);
            convertedParts[key] = model;
        }
        else if (chains && chains.length > 1) {
            var modelMap = {};
            chains.forEach((element, index) => {
                modelMap[`${key}-${index}`] = makerjs_1.default.chain.toNewModel(element, true);
            });
            convertedParts[key] = { models: modelMap };
        }
    });
    if (!convertedParts.bridge || !convertedParts.shape) {
        console.error("ERROR: Glasses parts need to have at least a bridge and a shape!");
        return {};
    }
    let bridgeMeas = makerjs_1.default.measure.modelExtents(convertedParts.bridge);
    let shapeMeas = makerjs_1.default.measure.modelExtents(convertedParts.shape);
    let isLeftSide = shapeMeas.center[0] < bridgeMeas.center[0];
    // move combined model to have origin [0, 0]
    let fullMeas = makerjs_1.default.measure.modelExtents({ models: convertedParts });
    let combined = { models: convertedParts, origin: p.scale(fullMeas.low, -1) };
    m.originate(combined);
    m.zero(combined);
    if (isLeftSide) {
        // mirror the parts so the bridge is the part that starts at 0
        Object.keys(combined.models).forEach(key => {
            const model = combined.models[key];
            combined.models[key] = m.distort(model, -1, 1);
        });
        m.zero(combined);
        m.originate(combined);
    }
    // move down so the vertical center line is 0
    let newBridgeMeas = makerjs_1.default.measure.modelExtents(combined.models.bridge);
    m.moveRelative(combined, [0, -newBridgeMeas.center[1]]);
    m.originate(combined);
    return combined.models;
}
exports.makeModelParts = makeModelParts;
function cleanupViaChains(model) {
    const options = {
        pointMatchingDistance: 0.01,
        shallow: false,
        unifyBeziers: false
    };
    const chains = m.findChains(model, options);
    var chainedParts = {};
    chains.forEach((element, index) => {
        // paths smaller then 1mm are artefacts that need to be removed
        if (element.pathLength < 1 || element.links.length < 3)
            return;
        chainedParts[`chain_${index}`] = makerjs_1.default.chain.toNewModel(element, true);
    });
    return { models: chainedParts };
}
function lineDistance(lineA, lineB) {
    let distSameDirection = makerjs_1.default.measure.pointDistance(lineA.origin, lineB.origin) + makerjs_1.default.measure.pointDistance(lineA.end, lineB.end);
    let distOppositeDirection = makerjs_1.default.measure.pointDistance(lineA.origin, lineB.end) + makerjs_1.default.measure.pointDistance(lineA.end, lineB.origin);
    return Math.min(distSameDirection, distOppositeDirection);
}
function checkLines(lineA, lineB, routeA, routeB, commonLines, linesToSubdivide) {
    let dAoBo = makerjs_1.default.measure.pointDistance(lineA.origin, lineB.origin);
    let dAeBe = makerjs_1.default.measure.pointDistance(lineA.end, lineB.end);
    let dAoBe = makerjs_1.default.measure.pointDistance(lineA.origin, lineB.end);
    let dAeBo = makerjs_1.default.measure.pointDistance(lineA.end, lineB.origin);
    // early exit if no points are close
    if (!(dAeBe < tol || dAeBe < tol || dAoBe < tol || dAeBo < tol))
        return;
    let distSameDirection = dAoBo + dAeBe;
    let distOppositeDirection = dAoBe + dAeBo;
    // when both lines are equal, we add them to the common lines
    if (Math.min(distSameDirection, distOppositeDirection) < tol) {
        commonLines.push([{ line: lineA, route: routeA }, { line: lineB, route: routeB }]);
        return;
    }
    // lines aren't exactly equal but might be colinear
    let isAtOriginA = dAoBo < tol || dAoBe < tol;
    let commonPA = isAtOriginA ? lineA.origin : lineA.end;
    let otherPA = isAtOriginA ? lineA.end : lineA.origin;
    let isAtOriginB = dAoBo < tol || dAeBo < tol;
    let commonPB = isAtOriginB ? lineB.origin : lineB.end;
    let otherPB = isAtOriginB ? lineB.end : lineB.origin;
    let vA = p.subtract(otherPA, commonPA);
    let vB = p.subtract(otherPB, commonPB);
    if (!sameDirection(vA, vB))
        return;
    // lines start in the same point and are pointing in the same direction, the longer vec should be subdivided
    let subdivideModelAorB = normSquared(vA) > normSquared(vB) ? 'a' : 'b';
    p.subtract(commonPA, lineA.origin);
    let lineToDivide = subdivideModelAorB === 'a' ? { line: lineA, route: routeA, isAtOrigin: isAtOriginA } : { line: lineB, route: routeB, isAtOrigin: isAtOriginB };
    linesToSubdivide.push({
        lineToDivide: lineToDivide,
        otherLine: subdivideModelAorB === 'a' ? { line: lineB, route: routeB } : { line: lineA, route: routeA },
        middlePoint: p.add(commonPA, subdivideModelAorB ? vB : vA),
        modelAorB: subdivideModelAorB
    });
}
function findConnections(modelA, modelB) {
    // find the line line that connects the two models
    var commonLines = [];
    // check whether colinear lines exist that need a subdivision
    var linesToSubdivide = [];
    let walkThroughA = {
        onPath: (wpA) => {
            if (makerjs_1.default.isPathLine(wpA.pathContext)) {
                let lineInA = wpA.pathContext;
                let walkThroughB = {
                    onPath: (wpB) => {
                        if (makerjs_1.default.isPathLine(wpB.pathContext)) {
                            let lineInB = wpB.pathContext;
                            checkLines(lineInA, lineInB, wpA.route, wpB.route, commonLines, linesToSubdivide);
                        }
                    }
                };
                m.walk(modelB, walkThroughB);
            }
            else if (makerjs_1.default.isPathArc(wpA.pathContext)) {
                // TODO: insert treatment when models meet in an arc
            }
            else {
                console.log("Unexpected path in shape: ", wpA.pathContext);
            }
        }
    };
    m.walk(modelA, walkThroughA);
    linesToSubdivide.forEach(info => {
        let partToModify = info.modelAorB === 'a' ? modelA : modelB;
        var addedLine;
        if (info.lineToDivide.isAtOrigin) {
            addedLine = new makerjs_1.default.paths.Line(p.clone(info.middlePoint), p.clone(info.lineToDivide.line.end));
            info.lineToDivide.line.end = p.clone(info.middlePoint);
        }
        else {
            addedLine = new makerjs_1.default.paths.Line(p.clone(info.lineToDivide.line.origin), p.clone(info.middlePoint));
            info.lineToDivide.line.origin = p.clone(info.middlePoint);
        }
        if (info.lineToDivide.route.length > 1 && info.lineToDivide.route[0] === 'paths' && partToModify.paths) {
            partToModify.paths[`${info.lineToDivide.route[1]}_add`] = addedLine;
        }
        else {
            console.error("Expected the subdivided line to have a route that starts with 'paths', found: ", info.lineToDivide.route);
        }
        commonLines.push([info.lineToDivide, info.otherLine]);
    });
    return commonLines;
}
function findPreviousAndNextLine(model, line) {
    var linesToTop = [];
    var linesToBottom = [];
    let topPoint = line.origin[1] > line.end[1] ? line.origin : line.end;
    let bottomPoint = line.origin[1] > line.end[1] ? line.end : line.origin;
    var walkOptions = {
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
                    linesToTop.push({
                        line: line, route: wp.route, isAtOrigin: originToTop < endTopTop
                    });
                if (distToBottom < tol)
                    linesToBottom.push({
                        line: line, route: wp.route, isAtOrigin: originToBottom < endToBottom
                    });
            }
            else if (makerjs_1.default.isPathArc(wp.pathContext)) {
                let arc = wp.pathContext;
                let endpoints = p.fromArc(arc);
                let startToTop = makerjs_1.default.measure.pointDistance(topPoint, endpoints[0]);
                let endTopTop = makerjs_1.default.measure.pointDistance(topPoint, endpoints[1]);
                let distToTop = Math.min(startToTop, endTopTop);
                let startToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, endpoints[0]);
                let endToBottom = makerjs_1.default.measure.pointDistance(bottomPoint, endpoints[1]);
                let distToBottom = Math.min(startToBottom, endToBottom);
                if (distToTop < tol)
                    linesToTop.push({
                        arc: arc, route: wp.route, isAt0: startToTop < endTopTop
                    });
                if (distToBottom < tol)
                    linesToBottom.push({
                        arc: arc, route: wp.route, isAt0: startToBottom < endToBottom
                    });
            }
        }
    };
    m.walk(model, walkOptions);
    return { pathsToTop: linesToTop, pathsToBottom: linesToBottom };
}
function justLines(paths) {
    let lines = paths.filter(path => path.line);
    return lines;
}
function findLineNotequal(lines, line) {
    return lines.find(lineInfo => lineDistance(lineInfo.line, line) > tol);
}
function clone(model) {
    return makerjs_1.default.cloneObject(model);
}
function lineInModel(model, lineInfo) {
    var runner = model;
    lineInfo.route.forEach(routeKey => runner = runner[routeKey]);
    if (makerjs_1.default.isPathLine(runner)) {
        let line = runner;
        return line;
    }
    return undefined;
}
function arcInModel(model, lineInfo) {
    var runner = model;
    lineInfo.route.forEach(routeKey => runner = runner[routeKey]);
    if (makerjs_1.default.isPathArc(runner)) {
        let arc = runner;
        return arc;
    }
    return undefined;
}
function setArcInModel(route, model, arc) {
    var runner = model;
    let lastKey = route.pop();
    route.forEach(routeKey => runner = runner[routeKey]);
    if (lastKey !== undefined) {
        runner[lastKey] = arc;
    }
    else {
        console.log("Failed to set arc for route: ", route);
    }
}
function setPointEqual(lineInfo, model, goalPoint) {
    let line = lineInModel(model, lineInfo);
    if (!line)
        return;
    if (lineInfo.isAtOrigin)
        line.origin = p.clone(goalPoint);
    else
        line.end = p.clone(goalPoint);
}
function highestLine(connections) {
    var currentTop = Number.NEGATIVE_INFINITY;
    var line;
    connections.forEach(linePair => {
        if (top(linePair[0].line)[1] > currentTop) {
            currentTop = top(linePair[0].line)[1];
            line = linePair;
        }
    });
    return line;
}
/**
 * Moves and adjusts the geometries of the provided shapes, so that their common lines
 * overlap exactly
 *
 * @param shapes the two shapes to be connected
 * @param connections the common lines between 1 and 2, supposed to be non-empty
 */
function reconnectShapes(shapes, connections, move, modify) {
    if (connections.length < 1)
        throw Error("The connections between shapes should be non empty!");
    let unmoved = move === 1 ? 0 : 1;
    m.originate({ models: { shape: shapes[0], hinge: shapes[1] } });
    let topLine = highestLine(connections);
    let topActualPoint = top(lineInModel(shapes[move], topLine[move]));
    let topGoalPoint = top(lineInModel(shapes[unmoved], topLine[unmoved]));
    let translation = p.subtract(topGoalPoint, topActualPoint);
    m.moveRelative(shapes[move], translation);
    // the bottom point gets adjusted so it fits again
    m.originate({ models: { shape: shapes[0], hinge: shapes[1] } });
    let unmodified = modify === 1 ? 0 : 1;
    let bottomGoalPoint = bottom(lineInModel(shapes[unmodified], topLine[unmodified]));
    let { pathsToBottom } = findPreviousAndNextLine(shapes[modify], lineInModel(shapes[modify], topLine[modify]));
    if (pathsToBottom.length !== 2) {
        console.error("Expected 2 lines to connect to a point in an endless curve, found ", pathsToBottom.length);
        return;
    }
    setConnectingLinesToGoal(pathsToBottom, shapes[modify], bottomGoalPoint);
    // adjust all other lines and points to equal 
    connections.forEach(connection => {
        if (lineDistance(connection[0].line, topLine[0].line) < tol)
            return;
        // Adjusting the lines which are not the top to be equal
        let goalLine = lineInModel(shapes[unmodified], connection[unmodified]);
        let { pathsToTop, pathsToBottom } = findPreviousAndNextLine(shapes[modify], lineInModel(shapes[modify], connection[modify]));
        setConnectingLinesToGoal(pathsToTop, shapes[modify], top(goalLine));
        setConnectingLinesToGoal(pathsToBottom, shapes[modify], bottom(goalLine));
    });
}
function setConnectingLinesToGoal(connectingPaths, modifiedShape, goalPoint) {
    connectingPaths.forEach(pathInfo => {
        if (pathInfo.line) {
            let lineInfo = pathInfo;
            setPointEqual(lineInfo, modifiedShape, goalPoint);
        }
        else if (pathInfo.arc) {
            let arcInfo = pathInfo;
            let currentArc = arcInModel(modifiedShape, arcInfo);
            let keepPoint = arcInfo.isAt0 ? p.fromArc(currentArc)[1] : p.fromArc(currentArc)[0];
            let newArc = new makerjs_1.default.paths.Arc(keepPoint, goalPoint, arcInfo.arc.radius, false, true);
            setArcInModel(arcInfo.route, modifiedShape, newArc);
        }
    });
}
/**
 * Combines the provided parts into a full glasses frame, given the provided sizes
 *
 * @param parts the two modeljs parts to be combined
 * @param sizes the chosen size parameters
 * @param defaultSizes the default size parameters
 * @param partial the partial step for debugging purposes
 */
function combineModel(parts, bridgeSize, glasWidth, glasHeight, defaultSizes, mergeHinge, step) {
    var warnings = [];
    if (!parts.shape || !parts.pad || !parts.bridge) {
        console.error("ERROR: So far only glasses that have a shape, bridge and pad can be combined!");
        warnings.push({ term: "frameupload.dxfwarning.partsMissing", data: {}, severity: "error" });
        return { model: {}, warnings: warnings };
    }
    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    let shape = clone(parts.shape);
    let pad = clone(parts.pad);
    let hinge = parts.hinge && clone(parts.hinge);
    let originalHingeMeas = hinge && makerjs_1.default.measure.modelExtents(hinge);
    let lens = parts.lens && clone(parts.lens);
    var bridge = clone(parts.bridge);

    // check connections and post warnings
    let shapePadConnections = findConnections(shape, pad);
    if (shapePadConnections.length < 1) {
        console.log("ERROR: Expected a single line in the Shape part that connects to the Pad, found ", shapePadConnections.length);
    }
    let shapeHingeConnections = hinge && findConnections(shape, hinge);
    if (hinge && shapeHingeConnections.length < 1) {
        console.log("ERROR: Expected some lines that connect/overlap between Shape and Hinge!");
        warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "shape", PART2: "hinge" }, severity: "error" });
    }
    let bridgeShapeConnections = findConnections(bridge, shape);
    if (bridgeShapeConnections.length < 1) {
        console.log("ERROR: Expected some lines that connect/overlap between Bridge and shape!");
        warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "bridge", PART2: "shape" }, severity: "error" });
    }
    let bridgeMeas = makerjs_1.default.measure.modelExtents(bridge);
    let shapeMeas = makerjs_1.default.measure.modelExtents(shape);
    let padMeas = makerjs_1.default.measure.modelExtents(pad);
    let padMin = padMeas.low[0];

    let bridgeFactor = 1 - (defaultSizes.bridgeSize - bridgeSize) / (2 * bridgeMeas.width);
    let bridgeXTranslation = (bridgeSize - defaultSizes.bridgeSize) / 2;
    let verticalFactor = glasHeight / defaultSizes.glasHeight;
    let horizontalFactor = glasWidth / defaultSizes.glasWidth;
    // next line is needed to fix issue with 62-18-37
    let floatingPointIncreaser = 1.00001;
    // scale bridge around center
    bridge = m.distort(bridge, bridgeFactor * floatingPointIncreaser, verticalFactor * floatingPointIncreaser);

    // scale shape
    m.moveRelative(shape, [-shapeMeas.low[0], 0]);
    m.originate(shape);
    shape = m.distort(shape, horizontalFactor, verticalFactor, false, 0.5);
    m.moveRelative(shape, [shapeMeas.low[0], 0]);
    // translate shape because bridge moved it's left start
    m.moveRelative(shape, [bridgeXTranslation, 0]);

    if (lens) {
        m.moveRelative(lens, [-shapeMeas.low[0], 0])
        m.originate(lens)
        lens = m.distort(lens, horizontalFactor, verticalFactor, false, 0.5)
        m.moveRelative(lens, [shapeMeas.low[0], 0])
        m.moveRelative(lens, [bridgeXTranslation, 0])    
    }

    if (bridgeShapeConnections.length > 0) {
        reconnectShapes([bridge, shape], bridgeShapeConnections, 1, 0);
    }

    if (step === 'scaled_parts')
        return { model: { models: { bridge: bridge, shape: shape, pad: pad, hinge: hinge } }, warnings: warnings };

    // move the hinge so it connects properly to the shape
    if (hinge && shapeHingeConnections.length > 0 && mergeHinge) {
        // Seems pointless, but the next line is so far needed otherwise atlas at 60-18-37 doesn't work
        hinge = m.distort(hinge, 1, 1);
        reconnectShapes([shape, hinge], shapeHingeConnections, 1, 0);
    } else if (hinge && !mergeHinge) {
        // move the hinge out a little, so it's not over the shape
        let shapeMax = makerjs_1.default.measure.modelExtents(shape).high[0];
        let hingeMin = originalHingeMeas.low[0];
        m.moveRelative(hinge, [(shapeMax - hingeMin) + 2, 0]);
    }

    // move the pad
    let lineInShape = shapePadConnections.length > 0 && shapePadConnections[0][0];
    let lineInPad = shapePadConnections.length > 0 && shapePadConnections[0][1];
    let padDelta = [padMeas.high[0] - shapeMeas.low[0], padMeas.high[1]];
    var padTranslation = [padDelta[0] * (horizontalFactor - 1), padDelta[1] * (verticalFactor - 1)];
    if (lineInShape && lineInPad) {
        let shapeLineMiddle = center(lineInModel(shape, lineInShape));
        let padLineMiddle = center(lineInModel(pad, lineInPad));
        padTranslation[1] = p.subtract(shapeLineMiddle, padLineMiddle)[1];
    }
    var totalPadTranslation = p.add([bridgeXTranslation, 0], padTranslation);
    let padDiff = padMin + totalPadTranslation[0] - minPadX;
    if (padDiff < 0) {
        totalPadTranslation[0] = minPadX - padMin;
    }
    m.moveRelative(pad, totalPadTranslation);

    // connect the pads to the shape on the connecting line
    m.originate({ models: { shape: shape, pad: pad } });
    if (lineInShape && lineInPad) {
        pad = m.distort(pad, 1, 1);
        // connecting the pad to the shape is special as we're trying to keep the angle of attack of the arm the same
        let shapeLine = lineInModel(shape, lineInShape);
        let connectingLines = findPreviousAndNextLine(pad, lineInPad.line);
        if (connectingLines) {
            let { pathsToTop, pathsToBottom } = connectingLines;
            let linesToTop = justLines(pathsToTop);
            let linesToBottom = justLines(pathsToBottom);
            if (shapeLine) {
                let topPoint = top(shapeLine);
                let bottomPoint = bottom(shapeLine);
                let padLineToTop = findLineNotequal(linesToTop, lineInPad.line);
                if (padLineToTop) {
                    let topHorizontalChange = p.subtract(topPoint, origin(padLineToTop))[0];
                    if (Math.abs(topHorizontalChange) > tol) {
                        // move the pad up/down so that the angle of the line stays the same
                        let slopeVec = p.subtract(end(padLineToTop), origin(padLineToTop));
                        if (Math.abs(slopeVec[0]) > tol) {
                            let slope = slopeVec[1] / slopeVec[0];
                            let verticalChange = -slope * topHorizontalChange;
                            m.moveRelative(pad, [0, verticalChange]);
                            m.originate({ models: { shape: shape, pad: pad } });
                        }
                    }
                }
                linesToTop.forEach(lineInfo => setPointEqual(lineInfo, pad, topPoint));
                linesToBottom.forEach(lineInfo => setPointEqual(lineInfo, pad, bottomPoint));
            }
            else {
                warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "pad", PART2: "shape" }, severity: "error" });
                console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!");
            }
        }
    }
    else {
        warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "pad", PART2: "shape" }, severity: "error" });
        console.log("ERROR: Failed to find line that connects Pad and Shape!");
    }
    if (parts.shape_holes) {
        let holes = clone(parts.shape_holes);
        // scale the hole positions the same way as the shape
        // basically what `holes = m.distort(holes, horizontalFactor, verticalFactor)` would do
        holes.models && Object.keys(holes.models).forEach(key => {
            if (!holes.models)
                return;
            let hole = holes.models[key];
            // we scale the shape from the lower end
            var center = p.subtract(makerjs_1.default.measure.modelExtents(hole).center, [shapeMeas.low[0], 0]);
            let scaledCenter = [center[0] * horizontalFactor, center[1] * verticalFactor];
            let diff = p.subtract(scaledCenter, center);
            m.moveRelative(hole, diff);
        });
        m.moveRelative(holes, [bridgeXTranslation, 0]);
        shape = m.combineSubtraction(shape, holes);
    }

    // holes in the hinge
    if (originalHingeMeas && parts.hinge_holes) {
        let holes = clone(parts.hinge_holes);
        let hingeMeas = makerjs_1.default.measure.modelExtents(hinge);
        // get the hinge position change
        let hingeTranslation = p.subtract(hingeMeas.center, originalHingeMeas.center);
        // move the holes accordingly
        holes.models && Object.keys(holes.models).forEach(key => {
            let hole = holes.models[key];
            m.moveRelative(hole, hingeTranslation);
        });
        hinge = m.combineSubtraction(hinge, holes);
    }

    if (shapePadConnections.length < 1) {
        console.log("No commonLines found, not even trying to combine");
        warnings.push({ term: "frameupload.dxfwarning.missingConnection", data: {}, severity: "error" });
        let fullFrame = { models: parts };
        return { model: fullFrame, warnings: warnings };
    }

    // convert the shapes into chains, to filter out artefacts
    pad = cleanupViaChains(pad);
    bridge = cleanupViaChains(bridge);
    shape = cleanupViaChains(shape);

    if (step === 'chained_parts')
        return { model: { models: { bridge: bridge, shape: shape, pad: pad, hinge: hinge } }, warnings: warnings };
    
    // combine the shapes into glasses
    // let options = {pointMatchingDistance: 0.005}
    let bridgeAndShape = m.combine(bridge, shape, false, true, false, true);
    if (step === 'bridge&Shape')
        return { model: { models: { bridgeAndShape: bridgeAndShape, pad: pad, hinge: hinge } }, warnings: warnings };
    let bridgeShapeAndHinge = m.combine(bridgeAndShape, hinge, false, true, false, true);
    if (step === 'bridge&Shape&Hinge')
        return { model: { models: { bridgeShapeAndHinge: bridgeShapeAndHinge, pad: pad } }, warnings: warnings };
    var fullSide = m.combine(bridgeShapeAndHinge, pad, false, true, false, true);

    // mirror the fullside and combine it together into a fullframe
    fullSide = cleanupViaChains(fullSide);
    if (step === 'fullside')
        return { model: fullSide, warnings: warnings };
    
    let mirroredSide = m.mirror(fullSide, true, false);
    let mirrorConnections = findConnections(fullSide, mirroredSide);
    if (mirrorConnections.length > 0)
        reconnectShapes([fullSide, mirroredSide], mirrorConnections, 0, 1);
    mirroredSide = cleanupViaChains(mirroredSide);
    m.moveRelative(mirroredSide, [0.0001, 0]);
    
    let fullFrame = m.combine(fullSide, mirroredSide, false, true, false, true, { trimDeadEnds: false });
 
    if (!mergeHinge && hinge) {
        let leftHinge = m.mirror(hinge, true, false);
        fullFrame = { models: { fullFrame: fullFrame, hinge: hinge, leftHinge: leftHinge } };
    }

    if (lens) {
        let leftLens = m.mirror(lens, true, false);
        fullFrame = { models: { fullFrame: fullFrame, lens: lens, leftLens: leftLens } };
    }

    return { model: fullFrame, warnings: warnings };
}
exports.combineModel = combineModel;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRFhGQ29tYmluZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJEWEZDb21iaW5lci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLHNEQUF1RDtBQUN2RCxvREFBNEI7QUFFNUIsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFBO0FBQ2hCLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQTtBQUNuQixJQUFJLENBQUMsR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQTtBQUNyQixJQUFJLENBQUMsR0FBRyxpQkFBTyxDQUFDLEtBQUssQ0FBQTtBQUVyQixNQUFNLFNBQVMsR0FBK0I7SUFDMUMsTUFBTSxFQUFFLENBQUMsUUFBUSxFQUFFLFNBQVMsRUFBRSxRQUFRLENBQUM7SUFDdkMsS0FBSyxFQUFFLENBQUMsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsWUFBWSxFQUFFLGFBQWEsQ0FBQztJQUMvRCxLQUFLLEVBQUUsQ0FBQyxPQUFPLEVBQUUsWUFBWSxFQUFFLGFBQWEsRUFBRSxPQUFPLENBQUM7SUFDdEQsR0FBRyxFQUFFLENBQUMsS0FBSyxFQUFFLFVBQVUsRUFBRSxXQUFXLENBQUM7Q0FDeEMsQ0FBQTtBQUVELElBQUksUUFBUSxHQUFHLFVBQVUsR0FBVztJQUNoQyxJQUFJLEdBQUcsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ25DLElBQUksR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7UUFDaEIsR0FBRyxHQUFHLEdBQUcsR0FBRyxHQUFHLENBQUM7S0FDbkI7SUFDRCxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUMsQ0FBQztBQUVGLFNBQVMsbUJBQW1CLENBQUMsR0FBa0I7SUFDM0MsSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUMsS0FBSyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFL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