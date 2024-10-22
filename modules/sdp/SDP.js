import $ from 'jquery';
import { cloneDeep } from 'lodash-es';
import transform from 'sdp-transform';
import { Strophe } from 'strophe.js';

import { MediaDirection } from '../../service/RTC/MediaDirection';
import { MediaType } from '../../service/RTC/MediaType';
import { XEP } from '../../service/xmpp/XMPPExtensioProtocols';
import browser from '../browser';

import SDPUtil from './SDPUtil';

/**
 * A class that translates the Jingle messages received from the signaling server into SDP format that the
 * browser understands and vice versa. This is needed for media session establishment and for signaling local and
 * remote sources across peers.
 */
export default class SDP {
    /**
     * Constructor.
     *
     * @param {string} sdp - The SDP generated by the browser when SDP->Jingle conversion is needed, an empty string
     * when Jingle->SDP conversion is needed.
     * @param {boolean} isP2P - Whether this SDP belongs to a p2p peerconnection.
     */
    constructor(sdp, isP2P = false) {
        const media = sdp.split('\r\nm=');

        for (let i = 1, length = media.length; i < length; i++) {
            let mediaI = `m=${media[i]}`;

            if (i !== length - 1) {
                mediaI += '\r\n';
            }
            media[i] = mediaI;
        }
        const session = `${media.shift()}\r\n`;

        this.isP2P = isP2P;
        this.media = media;
        this.raw = session + media.join('');
        this.session = session;

        // This flag will make {@link transportToJingle} and {@link jingle2media} replace ICE candidates IPs with
        // invalid value of '1.1.1.1' which will cause ICE failure. The flag is used in the automated testing.
        this.failICE = false;

        // Whether or not to remove TCP ice candidates when translating from/to jingle.
        this.removeTcpCandidates = false;

        // Whether or not to remove UDP ice candidates when translating from/to jingle.
        this.removeUdpCandidates = false;
    }

    /**
     * Adds a new m-line to the description so that a new local source can then be attached to the transceiver that gets
     * added after a reneogtiation cycle.
     *
     * @param {MediaType} mediaType media type of the new source that is being added.
     * @returns {void}
     */
    addMlineForNewLocalSource(mediaType) {
        const mid = this.media.length;
        const sdp = transform.parse(this.raw);
        const mline = cloneDeep(sdp.media.find(m => m.type === mediaType));

        // Edit media direction, mid and remove the existing ssrc lines in the m-line.
        mline.mid = mid;
        mline.direction = MediaDirection.RECVONLY;
        mline.msid = undefined;
        mline.ssrcs = undefined;
        mline.ssrcGroups = undefined;

        // We regenerate the BUNDLE group (since we added a new m-line).
        sdp.media = [ ...sdp.media, mline ];

        sdp.groups.forEach(group => {
            if (group.type === 'BUNDLE') {
                group.mids = [ ...group.mids.split(' '), mid ].join(' ');
            }
        });
        this.raw = transform.write(sdp);
    }

    /**
     * Checks if a given SSRC is present in the SDP.
     *
     * @param {string} ssrc
     * @returns {boolean}
     */
    containsSSRC(ssrc) {
        const sourceMap = this.getMediaSsrcMap();

        return [ ...sourceMap.values() ].some(media => media.ssrcs[ssrc]);
    }

    /**
     * Converts the Jingle message element to SDP.
     *
     * @param {*} jingle - The Jingle message element.
     * @returns {void}
     */
    fromJingle(jingle) {
        const sessionId = Date.now();

        // Use a unique session id for every TPC.
        this.raw = 'v=0\r\n'
            + `o=- ${sessionId} 2 IN IP4 0.0.0.0\r\n`
            + 's=-\r\n'
            + 't=0 0\r\n';

        const groups = $(jingle).find(`>group[xmlns='${XEP.BUNDLE_MEDIA}']`);

        if (groups.length) {
            groups.each((idx, group) => {
                const contents = $(group)
                    .find('>content')
                    .map((_, content) => content.getAttribute('name'))
                    .get();

                if (contents.length > 0) {
                    this.raw
                        += `a=group:${
                            group.getAttribute('semantics')
                                || group.getAttribute('type')} ${
                            contents.join(' ')}\r\n`;
                }
            });
        }

        this.session = this.raw;
        jingle.find('>content').each((_, content) => {
            const m = this.jingle2media($(content));

            this.media.push(m);
        });

        this.raw = this.session + this.media.join('');
    }

    /**
     * Returns an SSRC Map by extracting SSRCs and SSRC groups from all the m-lines in the SDP.
     *
     * @returns {*}
     */
    getMediaSsrcMap() {
        const sourceInfo = new Map();

        this.media.forEach((mediaItem, mediaindex) => {
            const mid = SDPUtil.parseMID(SDPUtil.findLine(mediaItem, 'a=mid:'));
            const mline = SDPUtil.parseMLine(mediaItem.split('\r\n')[0]);
            const media = {
                mediaindex,
                mediaType: mline.media,
                mid,
                ssrcs: {},
                ssrcGroups: []
            };

            SDPUtil.findLines(mediaItem, 'a=ssrc:').forEach(line => {
                const linessrc = line.substring(7).split(' ')[0];

                // Allocate new ChannelSsrc.
                if (!media.ssrcs[linessrc]) {
                    media.ssrcs[linessrc] = {
                        ssrc: linessrc,
                        lines: []
                    };
                }
                media.ssrcs[linessrc].lines.push(line);
            });

            SDPUtil.findLines(mediaItem, 'a=ssrc-group:').forEach(line => {
                const idx = line.indexOf(' ');
                const semantics = line.substr(0, idx).substr(13);
                const ssrcs = line.substr(14 + semantics.length).split(' ');

                if (ssrcs.length) {
                    media.ssrcGroups.push({
                        semantics,
                        ssrcs
                    });
                }
            });

            sourceInfo.set(mediaindex, media);
        });

        return sourceInfo;
    }

    /**
     * Converts the content section from Jingle to a media section that can be appended to the SDP.
     *
     * @param {*} content - The content section from the Jingle message element.
     * @returns {*} - The constructed media sections.
     */
    jingle2media(content) {
        const desc = content.find('>description');
        const transport = content.find(`>transport[xmlns='${XEP.ICE_UDP_TRANSPORT}']`);
        let sdp = '';
        const sctp = transport.find(`>sctpmap[xmlns='${XEP.SCTP_DATA_CHANNEL}']`);
        const media = { media: desc.attr('media') };

        media.port = '9';
        if (content.attr('senders') === 'rejected') {
            media.port = '0';
        }
        if (transport.find(`>fingerprint[xmlns='${XEP.DTLS_SRTP}']`).length) {
            media.proto = sctp.length ? 'UDP/DTLS/SCTP' : 'UDP/TLS/RTP/SAVPF';
        } else {
            media.proto = 'UDP/TLS/RTP/SAVPF';
        }
        if (sctp.length) {
            sdp += `m=application ${media.port} UDP/DTLS/SCTP webrtc-datachannel\r\n`;
            sdp += `a=sctp-port:${sctp.attr('number')}\r\n`;
            sdp += 'a=max-message-size:262144\r\n';
        } else {
            media.fmt
                = desc
                    .find('>payload-type')
                    .map((_, payloadType) => payloadType.getAttribute('id'))
                    .get();
            sdp += `${SDPUtil.buildMLine(media)}\r\n`;
        }

        sdp += 'c=IN IP4 0.0.0.0\r\n';
        if (!sctp.length) {
            sdp += 'a=rtcp:1 IN IP4 0.0.0.0\r\n';
        }

        if (transport.length) {
            if (transport.attr('ufrag')) {
                sdp += `${SDPUtil.buildICEUfrag(transport.attr('ufrag'))}\r\n`;
            }
            if (transport.attr('pwd')) {
                sdp += `${SDPUtil.buildICEPwd(transport.attr('pwd'))}\r\n`;
            }
            transport.find(`>fingerprint[xmlns='${XEP.DTLS_SRTP}']`).each((_, fingerprint) => {
                sdp += `a=fingerprint:${fingerprint.getAttribute('hash')} ${$(fingerprint).text()}\r\n`;
                if (fingerprint.hasAttribute('setup')) {
                    sdp += `a=setup:${fingerprint.getAttribute('setup')}\r\n`;
                }
            });
        }

        transport.find('>candidate').each((_, candidate) => {
            let protocol = candidate.getAttribute('protocol');

            protocol = typeof protocol === 'string' ? protocol.toLowerCase() : '';

            if ((this.removeTcpCandidates && (protocol === 'tcp' || protocol === 'ssltcp'))
                || (this.removeUdpCandidates && protocol === 'udp')) {
                return;
            } else if (this.failICE) {
                candidate.setAttribute('ip', '1.1.1.1');
            }

            sdp += SDPUtil.candidateFromJingle(candidate);
        });

        switch (content.attr('senders')) {
        case 'initiator':
            sdp += `a=${MediaDirection.SENDONLY}\r\n`;
            break;
        case 'responder':
            sdp += `a=${MediaDirection.RECVONLY}\r\n`;
            break;
        case 'none':
            sdp += `a=${MediaDirection.INACTIVE}\r\n`;
            break;
        case 'both':
            sdp += `a=${MediaDirection.SENDRECV}\r\n`;
            break;
        }
        sdp += `a=mid:${content.attr('name')}\r\n`;

        // <description><rtcp-mux/></description>
        // see http://code.google.com/p/libjingle/issues/detail?id=309 -- no spec though
        // and http://mail.jabber.org/pipermail/jingle/2011-December/001761.html
        if (desc.find('>rtcp-mux').length) {
            sdp += 'a=rtcp-mux\r\n';
        }

        desc.find('>payload-type').each((_, payloadType) => {
            sdp += `${SDPUtil.buildRTPMap(payloadType)}\r\n`;
            if ($(payloadType).find('>parameter').length) {
                sdp += `a=fmtp:${payloadType.getAttribute('id')} `;
                sdp += $(payloadType)
                    .find('>parameter')
                    .map((__, parameter) => {
                        const name = parameter.getAttribute('name');

                        return (name ? `${name}=` : '') + parameter.getAttribute('value');
                    })
                    .get()
                    .join(';');
                sdp += '\r\n';
            }

            sdp += this.rtcpFbFromJingle($(payloadType), payloadType.getAttribute('id'));
        });

        sdp += this.rtcpFbFromJingle(desc, '*');

        desc.find(`>rtp-hdrext[xmlns='${XEP.RTP_HEADER_EXTENSIONS}']`).each((_, hdrExt) => {
            sdp += `a=extmap:${hdrExt.getAttribute('id')} ${hdrExt.getAttribute('uri')}\r\n`;
        });
        if (desc.find(`>extmap-allow-mixed[xmlns='${XEP.RTP_HEADER_EXTENSIONS}']`).length > 0) {
            sdp += 'a=extmap-allow-mixed\r\n';
        }

        desc
            .find(`>ssrc-group[xmlns='${XEP.SOURCE_ATTRIBUTES}']`)
            .each((_, ssrcGroup) => {
                const semantics = ssrcGroup.getAttribute('semantics');
                const ssrcs
                    = $(ssrcGroup)
                        .find('>source')
                        .map((__, source) => source.getAttribute('ssrc'))
                        .get();

                if (ssrcs.length) {
                    sdp += `a=ssrc-group:${semantics} ${ssrcs.join(' ')}\r\n`;
                }
            });

        let userSources = '';
        let nonUserSources = '';

        desc
            .find(`>source[xmlns='${XEP.SOURCE_ATTRIBUTES}']`)
            .each((_, source) => {
                const ssrc = source.getAttribute('ssrc');
                let isUserSource = true;
                let sourceStr = '';

                $(source)
                    .find('>parameter')
                    .each((__, parameter) => {
                        const name = parameter.getAttribute('name');
                        let value = parameter.getAttribute('value');

                        value = SDPUtil.filterSpecialChars(value);
                        sourceStr += `a=ssrc:${ssrc} ${name}`;

                        if (value && value.length) {
                            sourceStr += `:${value}`;
                        }

                        sourceStr += '\r\n';

                        if (value?.includes('mixedmslabel')) {
                            isUserSource = false;
                        }
                    });

                if (isUserSource) {
                    userSources += sourceStr;
                } else {
                    nonUserSources += sourceStr;
                }
            });

        // Append sources in the correct order, the mixedmslable m-line which has the JVB's SSRC for RTCP termination
        // is expected to be in the first m-line.
        sdp += nonUserSources + userSources;

        return sdp;
    }

    /**
     * Coverts the RTCP attributes for the session from XMPP format to SDP.
     * https://xmpp.org/extensions/xep-0293.html
     *
     * @param {*} elem - Jingle message element.
     * @param {*} payloadtype - Payload type for the codec.
     * @returns {string}
     */
    rtcpFbFromJingle(elem, payloadtype) {
        let sdp = '';
        const feedbackElementTrrInt = elem.find(`>rtcp-fb-trr-int[xmlns='${XEP.RTP_FEEDBACK}']`);

        if (feedbackElementTrrInt.length) {
            sdp += 'a=rtcp-fb:* trr-int ';
            sdp += feedbackElementTrrInt.attr('value') || '0';
            sdp += '\r\n';
        }

        const feedbackElements = elem.find(`>rtcp-fb[xmlns='${XEP.RTP_FEEDBACK}']`);

        feedbackElements.each((_, fb) => {
            sdp += `a=rtcp-fb:${payloadtype} ${fb.getAttribute('type')}`;
            if (fb.hasAttribute('subtype')) {
                sdp += ` ${fb.getAttribute('subtype')}`;
            }
            sdp += '\r\n';
        });

        return sdp;
    }

    /**
     * Converts the RTCP attributes for the session from SDP to XMPP format.
     * https://xmpp.org/extensions/xep-0293.html
     *
     * @param {*} mediaIndex - The index of the media section in the SDP.
     * @param {*} elem - The Jingle message element.
     * @param {*} payloadtype - payload type for the codec.
     */
    rtcpFbToJingle(mediaIndex, elem, payloadtype) {
        const lines = SDPUtil.findLines(this.media[mediaIndex], `a=rtcp-fb:${payloadtype}`);

        lines.forEach(line => {
            const feedback = SDPUtil.parseRTCPFB(line);

            if (feedback.type === 'trr-int') {
                elem.c('rtcp-fb-trr-int', {
                    xmlns: XEP.RTP_FEEDBACK,
                    value: feedback.params[0]
                });
                elem.up();
            } else {
                elem.c('rtcp-fb', {
                    xmlns: XEP.RTP_FEEDBACK,
                    type: feedback.type
                });
                if (feedback.params.length > 0) {
                    elem.attrs({ 'subtype': feedback.params[0] });
                }
                elem.up();
            }
        });
    }

    /**
     * Converts the current SDP to a Jingle message that can be sent over the wire to a signaling server.
     *
     * @param {*} elem - The Jingle message element.
     * @param {*} thecreator - Sender role, whether it is an 'initiator' or 'responder'.
     * @returns - The updated Jingle message element.
     */
    toJingle(elem, thecreator) {
        SDPUtil.findLines(this.session, 'a=group:').forEach(line => {
            const parts = line.split(' ');
            const semantics = parts.shift().substr(8);

            elem.c('group', {
                xmlns: XEP.BUNDLE_MEDIA,
                semantics
            });

            // Bundle all the media types. Jicofo expects the 'application' media type to be signaled as 'data'.
            let mediaTypes = [ MediaType.AUDIO, MediaType.VIDEO, 'data' ];

            // For p2p connection, 'mid' will be used in the bundle group.
            if (this.isP2P) {
                mediaTypes = this.media.map(mediaItem => SDPUtil.parseMID(SDPUtil.findLine(mediaItem, 'a=mid:')));
            }
            mediaTypes.forEach(type => elem.c('content', { name: type }).up());
            elem.up();
        });

        this.media.forEach((mediaItem, i) => {
            const mline = SDPUtil.parseMLine(mediaItem.split('\r\n')[0]);
            const mediaType = mline.media === MediaType.APPLICATION ? 'data' : mline.media;

            let ssrc = false;
            const assrcline = SDPUtil.findLine(mediaItem, 'a=ssrc:');

            if (assrcline) {
                ssrc = assrcline.substring(7).split(' ')[0];
            }

            const contents = $(elem.tree()).find(`content[name='${mediaType}']`);

            // Append source groups from the new m-lines to the existing media description. The SDP will have multiple
            // m-lines for audio and video including the recv-only ones for remote sources but there needs to be only
            // one media description for a given media type that should include all the sources, i.e., both the camera
            // and screenshare sources should be added to the 'video' description.
            for (const content of contents) {
                if (!content.hasAttribute('creator')) {
                    // eslint-disable-next-line no-continue
                    continue;
                }

                if (ssrc) {
                    const description = $(content).find('description');
                    const ssrcMap = SDPUtil.parseSSRC(mediaItem);

                    for (const [ availableSsrc, ssrcParameters ] of ssrcMap) {
                        const sourceName = SDPUtil.parseSourceNameLine(ssrcParameters);
                        const videoType = SDPUtil.parseVideoTypeLine(ssrcParameters);
                        const source = Strophe.xmlElement('source', {
                            ssrc: availableSsrc,
                            name: sourceName,
                            videoType,
                            xmlns: XEP.SOURCE_ATTRIBUTES
                        });

                        const msid = SDPUtil.parseMSIDAttribute(ssrcParameters);

                        if (msid) {
                            const param = Strophe.xmlElement('parameter', {
                                name: 'msid',
                                value: msid
                            });

                            source.append(param);
                        }
                        description.append(source);
                    }

                    const ssrcGroupLines = SDPUtil.findLines(mediaItem, 'a=ssrc-group:');

                    ssrcGroupLines.forEach(line => {
                        const { semantics, ssrcs } = SDPUtil.parseSSRCGroupLine(line);

                        if (ssrcs.length) {
                            const group = Strophe.xmlElement('ssrc-group', {
                                semantics,
                                xmlns: XEP.SOURCE_ATTRIBUTES
                            });

                            for (const val of ssrcs) {
                                const src = Strophe.xmlElement('source', {
                                    ssrc: val
                                });

                                group.append(src);
                            }
                            description.append(group);
                        }
                    });
                }

                return;
            }
            const mid = SDPUtil.parseMID(SDPUtil.findLine(mediaItem, 'a=mid:'));

            elem.c('content', {
                creator: thecreator,
                name: this.isP2P ? mid : mediaType
            });

            if (mediaType === MediaType.VIDEO && typeof this.initialLastN === 'number') {
                elem.c('initial-last-n', {
                    xmlns: 'jitsi:colibri2',
                    value: this.initialLastN
                }).up();
            }

            if ([ MediaType.AUDIO, MediaType.VIDEO ].includes(mediaType)) {
                elem.c('description', {
                    xmlns: XEP.RTP_MEDIA,
                    media: mediaType
                });

                mline.fmt.forEach(format => {
                    const rtpmap = SDPUtil.findLine(mediaItem, `a=rtpmap:${format}`);

                    elem.c('payload-type', SDPUtil.parseRTPMap(rtpmap));

                    const afmtpline = SDPUtil.findLine(mediaItem, `a=fmtp:${format}`);

                    if (afmtpline) {
                        const fmtpParameters = SDPUtil.parseFmtp(afmtpline);

                        fmtpParameters.forEach(param => elem.c('parameter', param).up());
                    }

                    this.rtcpFbToJingle(i, elem, format);
                    elem.up();
                });

                if (ssrc) {
                    const ssrcMap = SDPUtil.parseSSRC(mediaItem);

                    for (const [ availableSsrc, ssrcParameters ] of ssrcMap) {
                        const sourceName = SDPUtil.parseSourceNameLine(ssrcParameters);
                        const videoType = SDPUtil.parseVideoTypeLine(ssrcParameters);

                        elem.c('source', {
                            ssrc: availableSsrc,
                            name: sourceName,
                            videoType,
                            xmlns: XEP.SOURCE_ATTRIBUTES
                        });

                        const msid = SDPUtil.parseMSIDAttribute(ssrcParameters);

                        if (msid) {
                            elem.c('parameter').attrs({
                                name: 'msid',
                                value: msid
                            });
                            elem.up();
                        }

                        elem.up();
                    }

                    const ssrcGroupLines = SDPUtil.findLines(mediaItem, 'a=ssrc-group:');

                    ssrcGroupLines.forEach(line => {
                        const { semantics, ssrcs } = SDPUtil.parseSSRCGroupLine(line);

                        if (ssrcs.length) {
                            elem.c('ssrc-group', {
                                semantics,
                                xmlns: XEP.SOURCE_ATTRIBUTES
                            });
                            ssrcs.forEach(s => elem.c('source', { ssrc: s }).up());
                            elem.up();
                        }
                    });
                }

                const ridLines = SDPUtil.findLines(mediaItem, 'a=rid:');

                if (ridLines.length && browser.usesRidsForSimulcast()) {
                    // Map a line which looks like "a=rid:2 send" to just the rid ("2").
                    const rids = ridLines.map(ridLine => ridLine.split(':')[1].split(' ')[0]);

                    rids.forEach(rid => {
                        elem.c('source', {
                            rid,
                            xmlns: XEP.SOURCE_ATTRIBUTES
                        });
                        elem.up();
                    });

                    const unifiedSimulcast = SDPUtil.findLine(mediaItem, 'a=simulcast:');

                    if (unifiedSimulcast) {
                        elem.c('rid-group', {
                            semantics: 'SIM',
                            xmlns: XEP.SOURCE_ATTRIBUTES
                        });
                        rids.forEach(rid => elem.c('source', { rid }).up());
                        elem.up();
                    }
                }

                if (SDPUtil.findLine(mediaItem, 'a=rtcp-mux')) {
                    elem.c('rtcp-mux').up();
                }

                this.rtcpFbToJingle(i, elem, '*');

                const extmapLines = SDPUtil.findLines(mediaItem, 'a=extmap:', this.session);

                extmapLines.forEach(extmapLine => {
                    const extmap = SDPUtil.parseExtmap(extmapLine);

                    elem.c('rtp-hdrext', {
                        xmlns: XEP.RTP_HEADER_EXTENSIONS,
                        uri: extmap.uri,
                        id: extmap.value
                    });

                    if (extmap.hasOwnProperty('direction')) {
                        switch (extmap.direction) {
                        case MediaDirection.SENDONLY:
                            elem.attrs({ senders: 'responder' });
                            break;
                        case MediaDirection.RECVONLY:
                            elem.attrs({ senders: 'initiator' });
                            break;
                        case MediaDirection.SENDRECV:
                            elem.attrs({ senders: 'both' });
                            break;
                        case MediaDirection.INACTIVE:
                            elem.attrs({ senders: 'none' });
                            break;
                        }
                    }

                    elem.up();
                });

                if (SDPUtil.findLine(mediaItem, 'a=extmap-allow-mixed', this.session)) {
                    elem.c('extmap-allow-mixed', {
                        xmlns: XEP.RTP_HEADER_EXTENSIONS
                    });
                    elem.up();
                }
                elem.up(); // end of description
            }

            // Map ice-ufrag/pwd, dtls fingerprint, candidates.
            this.transportToJingle(i, elem);

            // Set senders attribute based on media direction
            if (SDPUtil.findLine(mediaItem, `a=${MediaDirection.SENDRECV}`)) {
                elem.attrs({ senders: 'both' });
            } else if (SDPUtil.findLine(mediaItem, `a=${MediaDirection.SENDONLY}`)) {
                elem.attrs({ senders: 'initiator' });
            } else if (SDPUtil.findLine(mediaItem, `a=${MediaDirection.RECVONLY}`)) {
                elem.attrs({ senders: 'responder' });
            } else if (SDPUtil.findLine(mediaItem, `a=${MediaDirection.INACTIVE}`)) {
                elem.attrs({ senders: 'none' });
            }

            // Reject an m-line only when port is 0 and a=bundle-only is not present in the section.
            // The port is automatically set to 0 when bundle-only is used.
            if (mline.port === '0' && !SDPUtil.findLine(mediaItem, 'a=bundle-only', this.session)) {
                elem.attrs({ senders: 'rejected' });
            }
            elem.up(); // end of content
        });
        elem.up();

        return elem;
    }

    /**
     * Converts the session transport information from SDP to XMPP format.
     *
     * @param {*} mediaIndex The index for the m-line in the SDP.
     * @param {*} elem The transport element.
     */
    transportToJingle(mediaIndex, elem) {
        elem.c('transport');

        const sctpport = SDPUtil.findLine(this.media[mediaIndex], 'a=sctp-port:', this.session);
        const sctpmap = SDPUtil.findLine(this.media[mediaIndex], 'a=sctpmap:', this.session);

        if (sctpport) {
            const sctpAttrs = SDPUtil.parseSCTPPort(sctpport);

            elem.c('sctpmap', {
                xmlns: XEP.SCTP_DATA_CHANNEL,
                number: sctpAttrs, // SCTP port
                protocol: 'webrtc-datachannel' // protocol
            });

            // The parser currently requires streams to be present.
            elem.attrs({ streams: 0 });
            elem.up();
        } else if (sctpmap) {
            const sctpAttrs = SDPUtil.parseSCTPMap(sctpmap);

            elem.c('sctpmap', {
                xmlns: XEP.SCTP_DATA_CHANNEL,
                number: sctpAttrs[0], // SCTP port
                protocol: sctpAttrs[1] // protocol
            });

            // Optional stream count attribute.
            elem.attrs({ streams: sctpAttrs.length > 2 ? sctpAttrs[2] : 0 });
            elem.up();
        }

        const fingerprints = SDPUtil.findLines(this.media[mediaIndex], 'a=fingerprint:', this.session);

        fingerprints.forEach(line => {
            const fingerprint = SDPUtil.parseFingerprint(line);

            fingerprint.xmlns = XEP.DTLS_SRTP;

            elem.c('fingerprint').t(fingerprint.fingerprint);
            delete fingerprint.fingerprint;

            const setupLine = SDPUtil.findLine(this.media[mediaIndex], 'a=setup:', this.session);

            if (setupLine) {
                fingerprint.setup = setupLine.substr(8);
            }
            elem.attrs(fingerprint);
            elem.up(); // end of fingerprint
        });

        const iceParameters = SDPUtil.iceparams(this.media[mediaIndex], this.session);

        if (iceParameters) {
            iceParameters.xmlns = XEP.ICE_UDP_TRANSPORT;
            elem.attrs(iceParameters);

            const candidateLines = SDPUtil.findLines(this.media[mediaIndex], 'a=candidate:', this.session);

            candidateLines.forEach(line => { // add any a=candidate lines
                const candidate = SDPUtil.candidateToJingle(line);

                if (this.failICE) {
                    candidate.ip = '1.1.1.1';
                }

                const protocol = candidate && typeof candidate.protocol === 'string'
                    ? candidate.protocol.toLowerCase() : '';

                if ((this.removeTcpCandidates && (protocol === 'tcp' || protocol === 'ssltcp'))
                    || (this.removeUdpCandidates && protocol === 'udp')) {
                    return;
                }
                elem.c('candidate', candidate).up();
            });
        }
        elem.up(); // end of transport
    }
}
