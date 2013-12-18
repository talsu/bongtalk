"use strict";
/**
 * Module dependencies.
 */

var routes = require('./routes');
var user = require('./routes/user');
var express = require('express');
var http = require('http');
var path = require('path');
var util = require('util');
var redis = require("redis");
var Guid = require('guid');
var models = require('./models');
var RedisZones = models.RedisZones;
var JadeDataBinder = models.JadeDataBinder;

var RedisStore = require('connect-redis')(express);
var Sockets = require('socket.io');
var SessionSockets = require('session.socket.io');

exports.BongTalk = (function () {
    function BongTalk(servicePort, redisUrl) {
        this.id = Guid.create().value;
        this.servicePort = servicePort;
        this.redisUrl = redisUrl;
        this.sessionStore = new RedisStore({client:this.createRedisClient(this.redisUrl)});
        this.pub = this.createRedisClient(this.redisUrl);
        this.sub = this.createRedisClient(this.redisUrl);
        this.redisClient = this.createRedisClient(this.redisUrl)
        this.redisZones = new RedisZones(this.redisClient);
    }

    BongTalk.prototype.start = function (){
        var _this = this;

        this.subscribeRedis();

        var cookieParser = express.cookieParser('your secret here');

        var app = express();
        app.set('port', process.env.PORT || this.servicePort); //포트설정
        app.set('views', path.join(__dirname, 'views')); //
        app.set('view engine', 'jade');
        app.use(express.favicon());
        app.use(express.logger('dev'));
        app.use(express.json());
        app.use(express.urlencoded());
        app.use(express.methodOverride());
        app.use(express.static(path.join(__dirname, 'public')));
        app.use(cookieParser);
        app.use(express.session({store: this.sessionStore, key: 'jsessionid', secret: 'your secret here'}));
        app.use(app.router);

        // development only
        if ('development' === app.get('env')) {
            app.use(express.errorHandler());
        }

        app.get('/', routes.index);
        app.get('/status', function(req, res){res.render('status', { binder: new JadeDataBinder(_this) });});

        var server = http.createServer(app);
        server.listen(app.get('port'), function () {
            util.log('Server listening on port ' + app.get('port'));
        });

        var io = Sockets.listen(server);
        io.set('log level', 2); // 0 - error  1 - warn  2 - info  3 - debug

        var sessionSockets = new SessionSockets(io, this.sessionStore, cookieParser, 'jsessionid');

        sessionSockets.on('connection', function(err, socket, session){
            var sessionHasId = (session && session.hasOwnProperty('userId'));
            // 해당 Connection 에 대한 user다.
            var thisUser = new Object({
                id:  sessionHasId? session.userId : Guid.create().value,
                zoneId: (socket.handshake.query) ? socket.handshake.query.zoneId : 'default',
                socket:socket,
                session:session.id
            });

            if (!sessionHasId){
                _this.sessionStore.get(session.id, function(err, result){
                    result.userId = thisUser.id;
                    _this.sessionStore.set(session.id, result);
                });
            }
            else{

            }



            util.log("user '" + thisUser.id + "' connected");
            _this.redisZones.getUserName(thisUser.zoneId, thisUser.id, function(err, name){
                var user = {id : thisUser.id, name: name};
                util.log('sendProfile : ' + util.inspect(user));
                socket.emit('sendProfile', user);
            });

            socket.on('joinZone', function(data) {
                util.log('joinZone');
                _this.redisZones.joinZone(data.zoneId, data.user.id, data.user.name, function(err){
                    if (!err){
                        _this.redisZones.database.setUserName(data.zoneId, data.user.id, data.user.name, function(err){
                            if (!err){
                                thisUser.name = data.user.name;
                                _this.pub.publish('bongtalk:addUser', JSON.stringify( {zoneId: data.zoneId, userId : data.user.id}));
                            }
                        });
                    }
                });
            });

            socket.on('sendMessage', function(data){
//                if (user.currentZone) {
//                    user.currentZone.broadcastTalk(user, data);
//                }

                var talk = {
                    id:  Guid.create().value,
                    time: (new Date()).getTime(),
                    message: data,
                    user: {
                        id : thisUser.id,
                        name: thisUser.name
                    }
                };
                _this.publishEventToZone(thisUser.zoneId, 'sendMessage', talk);
//                _this.pub.publish('bongtalk:eventToZone', JSON.stringify({zoneId: thisUser.currentZoneId, eventName : 'sendMessage', message : talk}));
            });

            socket.on('changeName', function(name){
                _this.redisZones.database.setUserName(thisUser.zoneId, thisUser.id, name, function(err){
                    if (!err){
                        thisUser.name = name;
                        _this.pub.publish('bongtalk:addUser', JSON.stringify( {zoneId: thisUser.zoneId, userId : thisUser.id}));
                    }
                });
            });

            socket.on('disconnect', function(){
                _this.redisZones.leaveZone(thisUser.zoneId, thisUser.id, function(err, leavedZoneId){
                    if (!err){
                        _this.pub.publish('bongtalk:removeUser', JSON.stringify( {zoneId: thisUser.zoneId, userId : thisUser.id}));
                    }
                });
            });
        });
    };

    BongTalk.prototype.createRedisClient = function(redisUrl){
        if (redisUrl){
            var rtg   = require("url").parse(redisUrl);
            var redisClient = redis.createClient(rtg.port || 6379, rtg.hostname);
            if (rtg.auth)
            {
                var authString = rtg.auth;
                if (authString.indexOf(':') !== -1) {
                    authString = authString.split(":")[1];
                }

                redisClient.auth(authString);
            }

            return redisClient;
        }
        else{
            return redis.createClient();
        }
    };

    BongTalk.prototype.publishEventToZone = function(zoneId, eventName, message){
        this.pub.publish('bongtalk:eventToZone', JSON.stringify({zoneId: zoneId, eventName : eventName, message : message}));
    };

    BongTalk.prototype.publishEventToUser = function(zoneId, userId, eventName, message){
        this.pub.publish('bongtalk:eventToUser', JSON.stringify({zoneId:zoneId, userId:userId, eventName : eventName, message : message}));
    };

    BongTalk.prototype.subscribeRedis = function(){
        var _this = this;

        this.sub.subscribe('bongtalk:eventToZone');
        this.sub.subscribe('bongtalk:eventToUser');
        this.sub.subscribe('bongtalk:addUser');
        this.sub.subscribe('bongtalk:removeUser');
        this.sub.subscribe('bongtalk:changeName');

        this.sub.on('message', function (channel, event){
            var eventObj = null;
            try{
                eventObj = JSON.parse(event);
            }catch (ex) {}

            switch (channel)
            {
                case "bongtalk:eventToZone" :
                    _this.redisZones.eventToZone(eventObj);
                    break;
                case "bongtalk:eventToUser" :
                    _this.redisZones.eventToUser(eventObj);
                    break;
                case "bongtalk:addUser" :
                    if (eventObj.zoneId && eventObj.userId && (_this.redisZones.zones[eventObj.zoneId] || _this.redisZones.notJoinedUsers[eventObj.userId])){
                        _this.redisZones.getOrCreateUser(eventObj.userId, function(err, user){
                            if (!err){
                                //for exists User
                                _this.redisZones.addUser(user);
                                //for new User
                                for (var userKey in _this.redisZones.zones[user.currentZoneId].users){
                                    if (userKey !== user.id && _this.redisZones.userSockets.hasOwnProperty(userKey)){
                                        var targetUser = _this.redisZones.zones[user.currentZoneId].users[userKey];
                                        _this.publishEventToUser(user.currentZoneId, user.id, 'newUser', targetUser);
                                    }
                                }
                            }
                        });
                    }
                    break;
                case "bongtalk:removeUser" :
                    if (eventObj.zoneId && eventObj.userId && (_this.redisZones.zones[eventObj.zoneId] || _this.redisZones.notJoinedUsers[eventObj.userId])){
                        _this.redisZones.removeUser(eventObj.zoneId, eventObj.userId);
                    }
                    break;
                case "bongtalk:changeName" :
                    _this.redisZones.changeName(eventObj.zoneId, eventObj.message.id, eventObj.message.name);
                    _this.redisZones.eventToZone(eventObj);
                    break;
            }
        });
    };

    return BongTalk;
})();





