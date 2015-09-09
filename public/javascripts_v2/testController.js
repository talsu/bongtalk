bongtalkControllers.controller('TestController', ['$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalk', 'emitter',
	function($scope, $routeParams, $cookies, $location, ngDialog, bongtalk, emitter) {		
		var authToken = $cookies.getObject('auth_token');
		if (authToken) {
			bongtalk.setAuthToken(authToken);
			bongtalk.getMyInfo(function (res) {
				$scope.$apply(function (){
					if (res && !res.err && res.result) {
						//telegramTest();
						//telegramTest2();
						sessionCreationTest();
						//personalSessionCreationTest();
						//groupSessionCreationTest();
						//leaveAllSessionTest();
					}
					else {
						$location.path('/login');
					}
				});
			});
		}
		else {
			$location.path('/login');
		}

		function telegramTest() {			

			async.waterfall([
				AddSessionFunc('telegramTest', 'public'),
				GetSessionFunc(), 
				JoinSessoinFunc(),
				AddTelegramFunc("session", "join", null),
				GetTelegramsFunc(0,0),
				AddTelegramFunc("action", "writeStart", null),
				GetTelegramsFunc(0,0),
				AddTelegramFunc("talk", "text", 'hello world.'),
				GetTelegramsFunc(0,0),
				LeaveSessionFunc(),
				GetMyInfo()
			], function (err, result){
				if (err){
					console.error(err);
				}
			});
		}

		function telegramTest2() {			

			async.waterfall([
				AddSessionFunc('telegramTest2', 'public'),
				GetSessionFunc(), 
				JoinSessoinFunc(),
				AddTelegramFunc("session", "join", '@@@ START @@@'),				
				AddTelegramFunc("action", "writeStart", null),				
				AddTelegramFunc("talk", "text", 'INDEX 0'),
				AddTelegramFunc("session", "join", null),				
				AddTelegramFunc("session", "join", null),				
				AddTelegramFunc("action", "writeStart", null),		
				AddTelegramFunc("action", "writeStart", null),				
				AddTelegramFunc("talk", "text", 'INDEX 1'),
				AddTelegramFunc("session", "join", null),				
				AddTelegramFunc("action", "writeStart", null),				
				AddTelegramFunc("talk", "text", 'INDEX 2'),
				AddTelegramFunc("session", "join", null),				
				AddTelegramFunc("action", "writeStart", null),				
				AddTelegramFunc("talk", "text", 'INDEX 3'),
				AddTelegramFunc("session", "join", null),								
				AddTelegramFunc("session", "join", null),				
				AddTelegramFunc("action", "writeStart", null),				
				AddTelegramFunc("talk", "text", 'INDEX 4'),
				AddTelegramFunc("session", "join", null),				
				AddTelegramFunc("action", "writeStart", null),				
				AddTelegramFunc("talk", "text", 'INDEX 5'),
				AddTelegramFunc("session", "join", null),				
				AddTelegramFunc("action", "writeStart", null),				
				AddTelegramFunc("talk", "text", 'INDEX 6'),
				AddTelegramFunc("action", "writeEnd", null),				
				AddTelegramFunc("session", "leave", '@@@ END @@@'),
				GetTelegramsFunc(0, 5),
				LeaveSessionFunc(),
				GetMyInfo()
			], function (err, result){
				if (err){
					console.error(err);
				}
			});
		}

		function sessionCreationTest() {
			async.waterfall([
				AddSessionFunc('sessionCreationTest1', 'public'),
				GetSessionFunc(), 
				JoinSessoinFunc(),
				JoinSessoinFunc(),
				GetSessionFunc(),
				GetMyInfo(),
				GetUserSessionsFunc(),
				LeaveSessionFunc(),
				GetSessionFunc(), 
				GetMyInfo()
			], function (err, result){
				if (err){
					console.error(err);
				}
			});
		}

		function personalSessionCreationTest() {
			async.waterfall([
				AddSessionFunc('sessionCreationTest2', 'personal', ['test1']),		
				GetSessionFunc(),		
				LeaveSessionFunc(),
				GetSessionFunc(), 
				GetMyInfo()
			], function (err, result){
				if (err){
					console.error(err);
				}
			});
		}

		function groupSessionCreationTest() {
			async.waterfall([
				AddSessionFunc('sessionCreationTest3', 'group', ['test1', 'test2']),		
				GetSessionFunc(),		
				LeaveSessionFunc(),
				GetSessionFunc(), 
				GetMyInfo()
			], function (err, result){
				if (err){
					console.error(err);
				}
			});
		}

		function leaveAllSessionTest() {
			bongtalk.getMyInfo(function (res){
				if (res.err) {
					console.error(JSON.stringify(res.err));
					return;
				}

				async.each(res.result.sessions, 
					function (sessionId, callback){
						bongtalk.leaveSession(sessionId, function (res){
							if (res.err) {
								callback('leaveSession - Fail' + JSON.stringify(res.err));
								return;
							}
							console.log('leaveSession - '+sessionId+' - Success');
							console.log(JSON.stringify(res.result));
							callback();
						});
					},
					function (err){
						console.log(JSON.stringify(err));
						return;
					}
				);
			});		
		}


		function printRes() {
			return function (res){
				console.log(JSON.stringify(res));
			};
		}

		function GetMyInfo() {
			return function (sessionId, callback) {
				bongtalk.getMyInfo(function (res){
					if (res.err) {
						callback('getMyInfo - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('getMyInfo - Success');
					console.log(JSON.stringify(res.result));					
					callback(null, sessionId);
				});
			}
		}

		function AddSessionFunc(sessionName, type, users) {
			return function (callback) {
				bongtalk.addSession(sessionName, type, users, function (res) {	
					if (res.err) {
						callback('addSession - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('addSession - Success ['+sessionName+' | '+type+']');
					console.log(JSON.stringify(res.result));
					callback(null, res.result._id);
				});
			}
		}

		function GetSessionFunc() {
			return function (sessionId, callback) {
				bongtalk.getSession(sessionId, function (res){
					if (res.err) {
						callback('getSession - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('getSession - Success');
					console.log(JSON.stringify(res.result));					
					callback(null, sessionId);
				});
			}
		}

		function JoinSessoinFunc() {
			return function (sessionId, callback) {
				bongtalk.joinSession(sessionId, function (res){
					if (res.err) {
						callback('joinSession - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('joinSession - Success');
					console.log(JSON.stringify(res.result));
					callback(null, sessionId);
				});
			}
		}

		function LeaveSessionFunc() {
			return function (sessionId, callback) {
				bongtalk.leaveSession(sessionId, function (res){
					if (res.err) {
						callback('leaveSession - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('leaveSession - Success');
					console.log(JSON.stringify(res.result));
					callback(null, sessionId);
				});
			}
		}

		function GetUserSessionsFunc() {
			return function (sessionId, callback) {
				bongtalk.getUserSessions(function (res){
					if (res.err) {
						callback('getUserSessions - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('getUserSessions - Success');
					console.log(JSON.stringify(res.result));					
					callback(null, sessionId);
				});
			}
		}

		function AddTelegramFunc(type, subType, data){
			return function (sessionId, callback) {
				bongtalk.addTelegram(sessionId, type, subType, data, function (res){
					if (res.err) {
						callback('AddTelegramFunc - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('AddTelegramFunc - Success ['+type+' | '+subType+' | '+data+']');
					console.log(JSON.stringify(res.result));
					callback(null, sessionId);
				});
			};
		}

		function GetTelegramsFunc(skip, take){
			return function (sessionId, callback) {
				bongtalk.getTelegrams(sessionId, skip, take, function (res){
					if (res.err) {
						callback('getTelegrams - Fail' + JSON.stringify(res.err), null);
						return;
					}
					console.info('getTelegrams - Success ['+skip+' | '+take+']');
					console.log(JSON.stringify(res.result));
					callback(null, sessionId);
				});
			};
		}

		

	}]);