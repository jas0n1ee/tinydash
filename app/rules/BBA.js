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
    let kf_video_buffer = new KalmanFilter(rate, pnoise, mnoise);

    let Rmin = 0;
    let Rmax = 0;
    let reservoir = 1;
    let uper_reservoir = 0
    let cushion = 0;

    var quality = 0;
    var lastRate = 0;
    var curRate = 0;

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
        if (mediaType == 'video') {
            kf_video_buffer.update(target_buffer);
        }
        reservoir = Math.max(5, Math.floor(Math.min(kf_video_buffer.update(target_buffer),target_buffer)/4));
        cushion = target_buffer - reservoir - uper_reservoir;
        for (let i = 0; i < count; i++) {
            bandwidths.push(rulesContext.getMediaInfo().bitrateList[i].bandwidth);
        }

//        Rmin = bandwidths[0];
        Rmax = bandwidths[count - 1];
        currentBufferLevel = dashMetrics.getCurrentBufferLevel(metrics)
        console.log('Debug: ' + mediaType,' Buffer current/target len', currentBufferLevel + '/' + target_buffer)

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

        var trequest_h = parseInt(String(currentRequest.trequest).split(' ')[4].split(':')[0]);
        var tfinish_h = parseInt(String(currentRequest._tfinish).split(' ')[4].split(':')[0]); 
        var trequest_min = parseInt(String(currentRequest.trequest).split(' ')[4].split(':')[1]);
        var tfinish_min = parseInt(String(currentRequest._tfinish).split(' ')[4].split(':')[1]); 
        var trequest_sec = parseInt(String(currentRequest.trequest).split(' ')[4].split(':')[2]);
        var tfinish_sec = parseInt(String(currentRequest._tfinish).split(' ')[4].split(':')[2]); 
        var request_time = 3600 * (tfinish_h - trequest_h) + 60 * (tfinish_min - trequest_min) + (tfinish_sec - trequest_sec);
        console.log('Debug: request time: ', request_time);
        if (currentBufferLevel == 0) {
            quality = quality - 4.3 * request_time;
        }

        if (lastRequest === null) return SwitchRequest(context).create();
        //this is the last total request time
        var totalTime = (lastRequest._tfinish.getTime() - lastRequest.trequest.getTime()) / 1000;
        var downloadTime = (lastRequest._tfinish.getTime() - lastRequest.tresponse.getTime()) / 1000;
        if (totalTime <= 0) return SwitchRequest(context).create();
        var totalBytesLength = getBytesLength(lastRequest);
        totalBytesLength *= 8;
        var totalbandwidth = Math.floor(totalBytesLength / totalTime);
        calculatedBandwidth = 0;
        var kf = kf_video;
        if (mediaType == 'audio') {
            kf = kf_audio;
        }
        for (let j = 0; j < 2; j++) 
            kf.update(totalbandwidth)
        var calculatedBandwidth = Math.floor(kf.update(totalbandwidth));
        console.log('Debug: ' + mediaType + ' Rmin / kf estimated / last chunk bandwidth:' + Rmin/1000 + '/' + calculatedBandwidth / 1000 + '/' + totalbandwidth / 1000+  ' kbps');
        if( calculatedBandwidth >= Rmin * cushion  && totalbandwidth >= Rmin * cushion) {
            for (let i = 0; i < count ; i++) {
                //if (bandwidths[i] < Math.min(calculatedBandwidth,totalbandwidth) / cushion && bandwidths[i] > Rmin) {
                if (bandwidths[i] > Rmin) {
                    Rmin = bandwidths[i];
                    console.log('Debug ' + mediaType + 'switch Rmin to ' + Rmin / 1000 + ' kbps');
                    break
                }
            }
        }

        if (currentBufferLevel < reservoir) {
            console.log('Debug: requesting minimal rate');
            if (mediaType == 'video')
                Rmin = bandwidths[0];
            lastRate = curRate;
            curRate = Rmin / 1000;
            quality = quality + curRate - Math.abs(curRate - lastRate);
            console.log('Debug: lastRate / curRate: ' + lastRate + ' / ' + curRate);
            console.log('Debug: quality: ' + quality);
            return SwitchRequest(context).create(0, BBAClass.__dashjs_factory_name, SwitchRequest.PRIORITY.STRONG);
        }
        else {
            //let desire_bandwidth = (Rmax - Rmin)/ cushion * (currentBufferLevel - reservoir) + Rmin;
            let desire_bandwidth = Math.floor(Math.max((currentBufferLevel - reservoir + 1) * Rmin, Rmin));
            for (let i = count - 1; i >= 0; i--) {
                if (bandwidths[i] <= desire_bandwidth) {
                    lastRate = curRate;
                    curRate = bandwidths[i] / 1000;
                    quality = quality + curRate - Math.abs(curRate - lastRate);
                    console.log('Debug: lastRate / curRate: ' + lastRate + ' / ' + curRate);
                    console.log('Debug: quality: ' + quality);
                    console.log('Debug: ' + mediaType + ' desire / requesting / next level bandwidth ' + desire_bandwidth/1000 + '/' + bandwidths[i]/1000 + '/' + bandwidths[Math.min(i+1,count-1)]/1000 + 'kbps');
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
