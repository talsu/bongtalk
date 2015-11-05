
bongtalkControllers.factory('viewmodel', ['$rootScope', '$filter', '$location', '$routeParams', 'apiClient', 'bongtalkAutoRefreshToken', function ($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken) { 
    return BongtalkViewModel($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken);
}]);


(function () {
    "use strict";
    
    this.BongtalkViewModel = function ($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken) { return new BongtalkViewModel($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken); };
    
    var BongtalkViewModel = (function () {
        function BongtalkViewModel($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken) {
            this.instanceId = this.randomString(8);
            this.$rootScope = $rootScope;
            this.$filter = $filter;
            this.$location = $location;
            this.$routeParams = $routeParams;
            this.apiClient = apiClient;
            this.isLoaded = false;
            this.data = null;
            this.qufox = new Qufox(window.location.protocol + '//' + window.location.host);
            this.bongtalkAutoRefreshToken = bongtalkAutoRefreshToken;
            this.readyCallbackList = [];
        }
        
        BongtalkViewModel.prototype.ready = function (callback) {
            if (this.isLoaded) 
                callback();
            else 
                this.readyCallbackList.push(callback);
        };

        // context Load (signin or Window refresh)
        BongtalkViewModel.prototype.load = function (user, callback) {
            var self = this;
            if (!user) { callback('user is no exist', null); return; }
            self.apiClient.getUserSessions(user.id, function (err, result) {
                if (!err) {
                    self.data = { user: user, sessionList: result };
                    // token auto refresh service Start.
                    self.bongtalkAutoRefreshToken.start();
                    self.isLoaded = true;
                    
                    // join private session
                    self.qufox.join('private:' + user.id, function (packet) {
                        self.privatePacketReceived(packet);
                    });
                                     
                    // join sessions.
                    if (angular.isArray(self.data.sessionList)) {
                        _.each(self.data.sessionList, function (session) {
                            self.qufox.join('session:' + session._id, function (packet) {
                                self.sessionPacketReceived(session, packet);
                            });
                        });
                    }                    
                }

                // 콜백 호출.                    
                callback(err, result);
                if (self.readyCallbackList.length > 0) {
                    _.each(self.readyCallbackList, function (readyCallback) {
                        readyCallback(err, result);
                    });
                }
            });

            //this.apiClient.getContext(function (err, result) {
            //    if (!err) {
            //        self.data = result;
            //        self.tick();
            //        self.isLoaded = true;
            //        callback(err, result);
                    
            //        // 상담중인 Session 대화내역 가져오기.
            //        if (angular.isArray(self.data.SessionList)) {
            //            var connectedSessionList = self.$filter('isConnectedSession')(self.data.SessionList);
            //            _.each(connectedSessionList, function (session) { self.connectSession(session); });
            //        }
                    
            //        // 소속 채널 들에 대해서 Qufox 채널 Join
            //        if (angular.isArray(self.data.ChannelList)) {
            //            _.each(self.data.ChannelList, function (channel) {
            //                self.qufox.join('channel:' + channel, function (packet) {
            //                    // 채널 패킷 수신.
            //                    self.channelPacketReceived(channel, packet);
            //                });
            //            });
            //        }
                    
            //        // 시간 동기화
            //        self.syncServerTime();
            //    }
            //    else {
            //        callback(err, result);
            //    }
            //});
        };
        
        // context UnLoad (로그아웃)
        BongtalkViewModel.prototype.unload = function (callback) {
            this.isLoaded = false;
            this.data = null;
            this.bongtalkAutoRefreshToken.stop();
            this.qufox.leaveAll();
        };
        
        BongtalkViewModel.prototype.loadUsers = function (session, callback) {
            var self = this;
            if (!session) return;

            self.apiClient.getSessionUsers(session._id, function (err, result) {
                if (!err) {
                    session.users = result;
                }

                if (_.isFunction(callback)) callback(err, result);
            });
        };

        BongtalkViewModel.prototype.loadTelegrams = function (session, callback) {
            var self = this;
            
            if (session.isTelegramLoaded) {
                if (_.isFunction(callback)) callback(null, session.telegrams);
                return;
            }
            
            self.apiClient.getTelegrams(session._id, 0, 0, function (err, result) {
                if (!err && result && result.length > 0) {
                    _.each(result, function (telegram) {
                        self.addTelegram(session, telegram);
                    });
                    
                    session.isTelegramLoaded = true;
                }
                
                if (_.isFunction(callback)) callback(err, result);
            });
        };
        
        BongtalkViewModel.prototype.createAndJoinChat = function (name, type, callback) {
            var self = this;
            self.apiClient.addSession(name, type, [self.data.user.id], function (err, result) {
                if (!err) {
                    self.addSession(result);
                }

                if (_.isFunction(callback)) callback(err, result);
            });
            
            //ajaxAuthPost('api/sessions', this.token, { name: name, type: type, users: sessionUsers }, function (res) {
            //    if (!res.err) {
            //        if (self.user.sessions.indexOf(res.result._id) == -1) {
            //            self.user.sessions.push(res.result._id);
            //        }
            //        _.each(res.result.users, function (userId) {
            //            self.emitToUser(userId, 'joinSession', res.result._id);
            //        });
            //    }
            //    callback(res);
            //});
        };

        // Session 연결.
        BongtalkViewModel.prototype.connectSession = function (session, callback) {
            var self = this;
            // 대화내역 가져오기.
            self.apiClient.getSessionTalks(session.sessionId, function (err, result) {
                if (err) {
                    self.$rootScope.alert.add('대화내역 가져오기 실패', err);
                    return;
                }
                
                // talks Array 가 없다면 만들기.
                if (!session.talks || !angular.isArray(session.talks)) {
                    session.talks = [];
                }
                
                // 모두 addTalk 를 통해 추가.
                _.each(result, function (talk) { self.addTalk(session, talk); });
                
                // START_SERVICE 신호 보낸적 없으면 보내기.
                var startServiceTalk = self.searchTalk(session.sessionId, 'system', 'START_SERVICE');
                if (!startServiceTalk) {
                    self.sendTalk(session.sessionId, 'system', 'START_SERVICE');
                }
                
                // Ping 이 있는데 Pong 이 없으면 Pong 보내기.
                var pingTalk = self.searchTalk(session.sessionId, 'ping');
                var pongTalk = self.searchTalk(session.sessionId, 'pong');
                if (pingTalk && !pongTalk) {
                    self.sendTalk(session.sessionId, 'pong', navigator.userAgent.substring(0, 200));
                }
                
                // Connection 후 읽기로 했으면 readTalks 수행 아니면 ackTalks 수행
                if (session.readAfterConnected) {
                    self.readTalks(session);
                }
                else {
                    self.ackTalks(session);
                }
            });
            
            if (_.isFunction(callback)) callback();
            
            // [Qufox]Session Join
            self.qufox.join('session:' + session.sessionId, function (packet) {
                // Session 패킷 수신.
                self.sessionPacketReceived(session, packet);
            });
        };
        
        // Talk 검색
        BongtalkViewModel.prototype.searchTalk = function (sessionId, type, message) {
            var self = this;
            var targetSession = _.find(self.data.SessionList, function (s) { return s.sessionId == sessionId; });
            if (!targetSession || !targetSession.talks || !targetSession.talks.length) return null;
            if (message)
                return _.find(targetSession.talks, function (t) { return t.type == type && t.message == message; });
            else
                return _.find(targetSession.talks, function (t) { return t.type == type; });
        };
        
        BongtalkViewModel.prototype.sendTelegram = function (session, telegram, callback) {
            var self = this;
            if (!session || !telegram) return;

            // 추가
            self.addTelegram(session, telegram);
            self.apiClient.addTelegram(session._id, telegram.userName, telegram.type, telegram.subType, telegram.data, function (err, result) {
                if (err) {
                    if (_.isFunction(callback)) callback(err, result);
                }
                else {
                    telegram._id = result._id;
                    telegram.time = result.time;

                    self.qufox.send('session:' + session._id, result, function () {                        
                        if (_.isFunction(callback)) callback(err, result);
                    });
                }
            });
        };

        // talk 전송 (Context 추가 -> API 호출 -> Qufox 전송)
        BongtalkViewModel.prototype.sendTalk = function (sessionId, type, message, callback) {
            var self = this;
            if (!sessionId || !message) return;
            var session = _.find(self.data.SessionList, function (s) { return s.sessionId == sessionId; });
            if (!session) return;
            
            var talk = {
                id: self.randomString(8),
                type: type,
                userId: self.data.UserId,
                sessionId: sessionId,
                instanceId: self.instanceId,
                message: message,
                time: new Date().getTime()
            };
            
            // 화면에 먼저 그린다.
            self.addTalk(session, talk);
            
            // DB 저장
            self.apiClient.addTalk(talk, function (err, result) {
                if (err) {
                    if (_.isFunction(callback))
                        callback(err, result);
                    return;
                }
                
                // id 와 시간 업데이트
                talk.id = result.id;
                talk.time = result.time;
                
                // 소켓 서버에 전송 - 상대방에게 전송됨.
                self.qufox.send('session:' + sessionId, talk, function (res) {
                    self.$rootScope.$apply(function () {
                        if (_.isFunction(callback)) {
                            callback(null, talk);
                        }
                    });
                });
            });
        };
        
        BongtalkViewModel.prototype.addTelegram = function (session, telegram) {
            var self = this;
            if (!session) { return; }
            if (angular.isArray(session.telegrams)) {
                var existsTelegram = _.find(session.telegrams, function (t) { return t._id == telegram._id; });
                if (!existsTelegram) {
                    session.telegrams.push(telegram);
                }
            }
            else {
                session.telegrams = [telegram];
            }

            return telegram;
        };
        

        // talk 추가.
        BongtalkViewModel.prototype.addTalk = function (session, talk) {
            var self = this;
            if (!session) { return; }
            if (angular.isArray(session.telegrams)) {
                session.telegrams.push(talk);
            }
            else {
                session.talks = [talk];
            }
            
            if (talk.type == 'system') {
                switch (talk.message) {
                    case 'START_SERVICE':// 상담원 연결시 발생하는 상담 시작 신호.
                        if (!session.talkStartTime) { // 시작 시간이 없는데 Talk 이 왔다면 Update 해 준다.
                            session.talkStartTime = new Date(talk.time);
                            session.talkStartTimeLong = talk.time;
                        }
                        break;
                    case 'NOANSWER_END_SERVICE': // 상담원 - 무응답 종료.
                    case 'END_SERVICE': // 상담원 - 상담 종료.
                    case 'END_SERVICE_BY_CUSTOMER':// 고객 - 채팅 끝내기.
                        if (!session.talkEndTime) {
                            session.talkEndTime = new Date(talk.time);
                            session.talkEndTimeLong = talk.time;
                        }
                        // 자신의 session 이 아니면 닫기.
                        if (talk.instanceId != self.instanceId) {
                            // 세션 닫기
                            self.removeConnectedSession(session.sessionId);
                            // session 을 보고 있었다면. 나가기
                            if (self.$routeParams.sessionId == session.sessionId) {
                                self.$location.path('/chat');
                            }
                        }
                        break;
                }
            }
			// 사용자 액션 메세지.
            else if (talk.type == 'useraction' && talk.userId != self.data.UserId) {
                switch (talk.message) {
                    case 'WRITING_ON':
                        session.customerIsWriting = true;
                        break;
                    case 'WRITING_OFF':
                        session.customerIsWriting = false;
                        break;
                }
            }
			// Flow 메세지.
            else if (talk.type == 'flow') {
                var flowData = angular.fromJson(talk.message);
                var targetTalk = _.find(session.talks, function (t) { return t.id == flowData.talkId; });
                // isAcked, isRead flag 설정
                if (targetTalk && flowData.method == 'ACK') targetTalk.isAcked = true;
                if (targetTalk && flowData.method == 'READ') targetTalk.isRead = true;
                if (targetTalk && flowData.method == 'ACK_READ') targetTalk.isAcked = targetTalk.isRead = true;
            }
			// File 메세지 일 때 (파일 전송시 발생)
            else if (talk.type === 'file') {
                talk.message = angular.fromJson(talk.message);
                if (!talk.message) return;
                // 업로드 완료 메세지 발생.
                if (talk.message.action === 'uploadFinished' && talk.message.uploadTalkId) {
                    // 업로드 시작 메세지 삭제
                    session.talks = _.filter(session.talks, function (t) { return t.id !== talk.message.uploadTalkId; });;
                    
                    // 에러 상태이면 업로드 완료 메세지도 삭제
                    if (talk.message.err) {
                        session.talks = _.filter(session.talks, function (t) { return t.id !== talk.id; });;
                    }
                }
            }
            
            return talk;
        };
        
        // 응답하지 않은 message 들 응답하기
        BongtalkViewModel.prototype.ackTalks = function (session) {
            var self = this;
            if (!session || !angular.isArray(session.talks)) return;
            
            var notAckedTalks = _.filter(session.talks, function (t) { return !t.type && t.userId != self.data.UserId && !t.isAcked; });
            
            _.each(notAckedTalks, function (t) { self.sendFlowTalk(session.sessionId, 'ACK', t.id); });
        };
        
        // Session 이동시 읽음 처리
        BongtalkViewModel.prototype.readTalks = function (session) {
            var self = this;
            if (!session) return;
            
            // 수행 함으로. flag off
            if (session.readAfterConnected) session.readAfterConnected = false;
            
            // talks 가 아에 없다면 아직 연결되지 않은 session 이다. 다음번 연결에 시도 하도록 한다.
            if (!session.talks) { session.readAfterConnected = true; return; }
            
            var notAckedTalks = _.filter(session.talks, function (t) { return !t.type && t.userId != self.data.UserId && !t.isAcked });
            var notReadTalks = _.filter(session.talks, function (t) { return !t.type && t.userId != self.data.UserId && t.isAcked && !t.isRead; });
            
            _.each(notAckedTalks, function (t) { self.sendFlowTalk(session.sessionId, 'ACK_READ', t.id); });
            _.each(notReadTalks, function (t) { self.sendFlowTalk(session.sessionId, 'READ', t.id); });
        };
        
        // Session 추가
        BongtalkViewModel.prototype.addSession = function (session) {
            var self = this;
            // Add to SessionList
            if (!_.find(self.data.sessionList, function (s) { return s._id == session._id; })) {
                self.data.sessionList.push(session);
                self.qufox.join('session:' + session._id, function (packet) {
                    self.sessionPacketReceived(session, packet);
                });
            }
            
            // setUserInfo
            if (self.data.user.sessions.indexOf(session._id) == -1) {
                self.data.user.sessions.push(session._id);
            }
            

     //       var self = this;
     //       if (!session) return;
     //       if (self.data && angular.isArray(self.data.SessionList)) {
     //           // 이미 존재 하는지 확인.
     //           var index = _.findIndex(self.data.SessionList, function (s) { return s.sessionId == session.sessionId });
     //           if (index == -1) {
     //               // 없으면 List 에 추가.
     //               self.data.SessionList.push(session);
					////self.connectSession(session);
     //           }
     //           else {
     //               self.data.SessionList[index] = session;
     //           }
     //       }
        };
        
        // 대기목록 추가 - 고객이 채널에서 Session 만듬.
        BongtalkViewModel.prototype.addWaitingSession = function (sessionId) {
            var self = this;
            self.apiClient.getSession(sessionId, function (err, session) {
                self.addSession(session);
            });
        };
        
        // 상담중 목록 추가 - 자신이 Catch.
        BongtalkViewModel.prototype.addConnectingSession = function (sessionId, callback) {
            var self = this;
            self.apiClient.getSession(sessionId, function (err, session) {
                self.addSession(session);
                self.connectSession(session, callback);
				//if (_.isFunction(callback)) callback(err, session);
            });
        };
        
        // 연결된 Session 삭제 - 상담종료
        BongtalkViewModel.prototype.removeConnectedSession = function (sessionId) {
            var self = this;
            if (!self.data || !self.data.SessionList || !self.data.SessionList.length) return;
            
            // qufox leave
            self.qufox.leave('session:' + sessionId, function () { });
            // 삭제
            self.data.SessionList = _.filter(self.data.SessionList, function (session) { return session.sessionId != sessionId; });;
        };
        
        // 대기 목록에서 삭제 - 고객이 나감 or 다른 상담원이 Catch
        BongtalkViewModel.prototype.removeWaitingSession = function (sessionId) {
            var self = this;
            if (self.data && angular.isArray(self.data.SessionList)) {
                // 대기목록에 있다면
                var waitingSessions = self.$filter('isWaitingSession')(self.data.SessionList);
                if (_.find(waitingSessions, function (session) { return session.sessionId == sessionId; })) {
                    // 삭제
                    self.data.SessionList = _.filter(self.data.SessionList, function (session) { return session.sessionId != sessionId; });;
                }
            }
        };
        
        // 유형 목록 업데이트
        BongtalkViewModel.prototype.updateInquryType = function (groupCode, code) {
            var self = this;
            // updateInquiryType
            if (self.data && !self.data.InquiryTypes[code]) {
                self.apiClient.getInquiryTypes(groupCode, code, function (err, result) {
                    if (!err) {
                        self.data.InquiryTypes[code] = result;
                        _.each(result, function (type) {
                            if (type && type.code && type.codeName)
                                self.data.InquiryTypeMap[type.code] = { group: groupCode, name: type.codeName };
                        });
                    }
                });
            }
        };
        
        // [Qufox] CATCH_SESSION 알림 (자신이 포함된 BroadCast)
        BongtalkViewModel.prototype.broadcastCatchSession = function (channelCode, sessionId) {
            var self = this;
            self.qufox.send('channel:' + channelCode, {
                type: 'CATCH_SESSION',
                sessionId: sessionId,
                instanceId: self.instanceId,
                userId: self.data.UserId
            }, true, function () { });
        };
        
        // [Qufox] 채널 메세지 수신.
        BongtalkViewModel.prototype.channelPacketReceived = function (channel, packet) {
            var self = this;
            self.$rootScope.$apply(function () {
                if (packet && packet.type && packet.sessionId) {
                    //if - CreateSession 대기중 목록에 추가.
                    if (packet.type == "NEW_SESSION") {
                        self.addWaitingSession(packet.sessionId);
                    }					
					//if - LEAVE_CUSTOMER  대기중 목록에서 제거.
                    else if (packet.type == "LEAVE_CUSTOMER") {
                        self.removeWaitingSession(packet.sessionId);
                    }
					//if - CatchSession  대기중 목록에서 제거.
                    else if (packet.type == "CATCH_SESSION") {
                        self.removeWaitingSession(packet.sessionId);
                        if (packet.userId == self.data.UserId) {
                            self.addConnectingSession(packet.sessionId, function () {
                                // 본인의 신호라면 session 이동.
                                if (packet.instanceId == self.instanceId) {
                                    self.$location.path('/chat/' + packet.sessionId);
                                }
                            });
                        }
                    }
                }
            });
        };
        
        BongtalkViewModel.prototype.privatePacketReceived = function (packet) {
            var self = this;
            if (!self.data || !packet.object) return;
            self.$rootScope.$apply(function () {
                switch (packet.name) {
                    case 'setMyInfo':
                        for (var property in packet.object) {
                            self.data.user[property] = packet.object[property];
                        }
                        break;
                    case 'joinSession':
                        var sessionId = packet.object;
                        if (!_.find(self.data.sessionList, function (s) { return s._id == result._id; })) {
                            self.getSession(sessionId, function (err, result) {
                                if (err) return;
                                
                                self.addSession(result);
                            });
                        }
                        break;
                    case 'leaveSession':
                        var sessionId = packet.object;
                        
                        // remove from SessionList
                        var index = _.findIndex(self.data.sessionList, function (s) { return s._id == sessionId; });
                        if (index > -1) {
                            var session = $scope.sessions.splice(index, 1);
                            if (session) {
                                self.qufox.leave('session:' + session._id);
                            }
                        }
                        
                        // setUserInfo
                        var index = self.data.user.sessions.indexOf(sessionId);
                        if (index > -1) {
                            self.data.user.sessions.splice(index, 1);
                        }
                        break;
                }
            });
        };
        
        // [Qufox] Session 메세지 수신.
        BongtalkViewModel.prototype.sessionPacketReceived = function (session, packet) {
            var self = this;
            self.$rootScope.$apply(function () {
                var telegram = self.addTelegram(session, packet);
                //var talk = self.addTalk(session, packet);
                
                //// ping 을 받으면 pong 을 보낸다.
                //if (talk.type == 'ping') self.sendTalk(session.sessionId, 'pong', navigator.userAgent.substring(0, 200));
                
                //// 상대방이 전송한 일반메시지 수신
                //if (!packet.type && packet.userId != self.data.UserId) {
                //    // 현재 보고 있는 Session 이면 ACK_READ 아니면 ACK를 보낸다.
                //    var method = self.$routeParams.sessionId == session.sessionId ? 'ACK_READ' : 'ACK';
                //    self.sendFlowTalk(session.sessionId, method, packet.id);
                //}
            });
        };
        
        // Flow talk 전송.
        BongtalkViewModel.prototype.sendFlowTalk = function (sessionId, method, talkId) {
            var self = this;
            var data = {
                method: method,
                talkId: talkId,
                instanceId: self.instanceId,
            };
            
            // 현재 보고 있는 Session 이면 ACK_READ 아니면 ACK를 보낸다.
            self.sendTalk(sessionId, 'flow', angular.toJson(data));
        };
        
        // 500ms Tick - 실시간 시간 업데이트
        BongtalkViewModel.prototype.tick = function () {
            var self = this;
            if (!this.data) return;
            // Session 시간 업데이트.
            if (angular.isArray(this.data.SessionList)) {
                
                //시간 업데이트
                _.each(this.data.SessionList, function (session) {
                    if (session.talkStartTimeLong) { // 시작 시간이 있으면 시작 시간 - 요청시간
                        // 대기시간
                        session.talkWaitingTimeLong = session.talkStartTimeLong - session.talkRequestTimeLong;
                        // 상담 진행 시간
                        session.talkDoingTimeLong = self.getServerTime() - session.talkStartTimeLong;
                    }
                    else { // 현재시간 - 요청시간
                        session.talkWaitingTimeLong = self.getServerTime() - session.talkRequestTimeLong;
                    }
                });
                
                var talkWaitingTimeLongSum = _.reduce(this.data.SessionList, function (a, b) { return a + b.talkWaitingTimeLong; }, 0);
                this.data.talkWaitingTimeLongAvg = talkWaitingTimeLongSum / this.data.SessionList.length;
            }
            
            if (!this.data.InquiryTypes) this.data.InquiryTypes = {};
            if (!this.data.InquiryTypeMap) {
                this.data.InquiryTypeMap = {};
                if (angular.isArray(this.data.CenterTypes)) {
                    _.each(this.data.CenterTypes, function (type) {
                        if (type && type.code && type.codeName)
                            self.data.InquiryTypeMap[type.code] = { group: 'SQM095', name: type.codeName };
                    });
                }
            }
        };
        
        // 서버시간 동기화
        BongtalkViewModel.prototype.syncServerTime = function () {
            var self = this;
            var clientTime = Date.now();
            self.apiClient.syncTime(clientTime, function (err, data) {
                if (!err) {
                    var nowTime = Date.now();
                    self.serverTimeOffset = ((data.serverTime - clientTime) + (data.serverTime - nowTime)) / 2;
                }
            });
        };
        
        // 동기화된 서버시간
        BongtalkViewModel.prototype.getServerTime = function () {
            return Date.now() + (this.serverTimeOffset || 0);
        };
        
        // Random 문자열 만들기.
        BongtalkViewModel.prototype.randomString = function (length) {
            var letters = 'abcdefghijklmnopqrstuvwxyz';
            var numbers = '1234567890';
            var charset = letters + letters.toUpperCase() + numbers;
            
            function randomElement(array) {
                return array[Math.floor(Math.random() * array.length)];
            }
            
            var result = '';
            for (var i = 0; i < length; i++)
                result += randomElement(charset);
            return result;
        };
        
        return BongtalkViewModel;
    })();

}.call(this));