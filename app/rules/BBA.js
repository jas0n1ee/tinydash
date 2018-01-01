/**
    
 */
var BBA;

function BBAClass() {

    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let DashMetrics = factory.getSingletonFactoryByName('DashMetrics');
    let MetricsModel = factory.getSingletonFactoryByName('MetricsModel');
    let DashManifestModel = factory.getSingletonFactoryByName('DashManifestModel');
    let StreamController = factory.getSingletonFactoryByName('StreamController');
    
    let context = this.context;
    var rate = 0.02;
    var pnoise = 10;
    var mnoise = 3;
    let kf_video = new KalmanFilter(rate, pnoise, mnoise);
    let kf_audio = new KalmanFilter(rate, pnoise, mnoise);

    let Rmin = 0;
    let Rmax = 0;
    let reservoir = 1;
    let uper_reservoir = 0
    let cushion = 0;

    function getBytesLength(request) {
        return request.trace.reduce((a, b) => a + b.b[0], 0);
    }
    function getMaxIndex(rulesContext) {
        // here you can get some informations aboit metrics for example, to implement the rule
        let metricsModel = MetricsModel(context).getInstance();
        let dashMetrics = DashMetrics(context).getInstance();

        var mediaType = rulesContext.getMediaInfo().type;
        var metrics = metricsModel.getReadOnlyMetricsFor(mediaType);
        var requests = dashMetrics.getHttpRequests(metrics);
        var lastRequest = null;
        var currentRequest = null;

        let bandwidths=[];
        let currentBufferLevel=0;
        let count = rulesContext.getMediaInfo().representationCount;

        if (!metrics) {
            return SwitchRequest(context).create();
        }
        let target_buffer = metrics.BufferState[metrics.BufferState.length-1].target;
        reservoir = Math.max(5, Math.floor(target_buffer/4));
        console.log('Debug: ' + mediaType +  ' system target buffer ' + target_buffer)
        cushion = target_buffer - reservoir - uper_reservoir;
        for (let i = 0; i < count; i++) {
            bandwidths.push(rulesContext.getMediaInfo().bitrateList[i].bandwidth);
        }

        Rmin = bandwidths[0];
        Rmax = bandwidths[count - 1];
        currentBufferLevel = dashMetrics.getCurrentBufferLevel(metrics)
        console.log('Debug: ' + mediaType,' Buffer len', currentBufferLevel)

        // Get last valid request
        var i = requests.length - 1;
        while (i >= 0 && lastRequest === null) {
            currentRequest = requests[i];
            if (currentRequest._tfinish &&
                currentRequest.trequest &&
                currentRequest.tresponse &&
                currentRequest.trace &&
                currentRequest.trace.length > 0) {
                lastRequest = requests[i];
            }
            i--;
        }

        if (lastRequest === null) return SwitchRequest(context).create();
        //this is the last total request time
        var totalTime = (lastRequest._tfinish.getTime() - lastRequest.trequest.getTime()) / 1000;
        var downloadTime = (lastRequest._tfinish.getTime() - lastRequest.tresponse.getTime()) / 1000;
        if (totalTime <= 0) return SwitchRequest(context).create();
        var totalBytesLength = getBytesLength(lastRequest);
        totalBytesLength *= 8;
        var totalbandwidth = totalBytesLength / totalTime;
        calculatedBandwidth = 0;
        var kf = kf_video;
        if (mediaType == 'audio') {
            kf = kf_audio;
        }
        var calculatedBandwidth = kf.update(totalbandwidth);
        console.log('Debug: ' + mediaType + ' kf estimated bandwidth:' + calculatedBandwidth / 1000 +  ' bps');
        console.log('Debug: ' + mediaType + ' last chunk bandwidth:' + totalbandwidth / 1000 + ' bps');

        if (currentBufferLevel < reservoir) {
            console.log('Debug: requesting minimal rate');
            return SwitchRequest(context).create(0, BBAClass.__dashjs_factory_name, SwitchRequest.PRIORITY.STRONG);
        }
        else {
            //let desire_bandwidth = (Rmax - Rmin)/ cushion * (currentBufferLevel - reservoir) + Rmin;
            let desire_bandwidth = Math.max((currentBufferLevel - reservoir + 1) * Rmin, Rmin);
            console.log('Debug: ' + mediaType + ' desire_bandwidth ' + desire_bandwidth/1000 + 'kbps');
            for (let i = count - 1; i >= 0; i--) {
                if (bandwidths[i] <= desire_bandwidth) {
                    console.log('Debug: ' + mediaType + ' requesting ' + i + ' with bandwidth ' + bandwidths[i]/1000 + 'kbps');
                    console.log('Debug: ' + mediaType + ' next level of bandwidth ' + bandwidths[Math.max(i+1,count-1)]/1000 + 'kbps');
                    return SwitchRequest(context).create(i, BBAClass.__dashjs_factory_name, SwitchRequest.PRIORITY.STRONG);
                    break; 
                }
            }
        }
    }

    const instance = {
        getMaxIndex: getMaxIndex
    };
    return instance;
}

BBAClass.__dashjs_factory_name = 'BBA';
BBA = dashjs.FactoryMaker.getClassFactory(BBAClass);
