'use strict';

define(['controllers', 'underscore', 'modules/socketConnector'], function (controllers, _, connector){

	controllers.controller('listCtrl', [ '$scope', '$location', function($scope, $location){
		$scope.orderProp = 'age';
		$scope.serverStatus = 'connecting';
		
		// $scope.createChannel = function(channel){
		// 	connector.request('addUserToChannel', {channelId:channel, userName:'test'}, function(res){
		// 		if (!res.err){
		// 			var id = res.result;
		// 			console.log(id);
		// 		}
		// 	});

		// 	$scope.joinPopupChannel(channel);
		// };

		$scope.updateChannelList = function(){
			connector.request('getAllChannel', {}, function(response){
				if (!response.err){
					var items = _.map(response.result, function(channelName){ return {name:channelName}; });
					$scope.$apply(function(){
						$scope.channels = items;
					});
				}
			});
		};

		$scope.createAccount = function(name){
			connector.request('addUserToChannel', {channelId:'default', userName:name}, function(res){
				if (!res.err){
					$scope.profile = res.result;
				}
			});
		};

		$scope.joinChannel = function(channelId){
			var query = [];
			if ($scope.profile){
				if ($scope.profile.id){
					query.push('userid=' + $scope.profile.id);
				}
				if ($scope.profile.name){
					query.push('username=' + $scope.profile.name);
				}				
			}

			var querystring = query.length > 0 ? ('?' + query.join('&')) : '';

			window.location = encodeURI('#/ch/' + channelId + querystring);
		};

		$scope.joinPopupChannel = function(channelId){
			var query = [];
			if ($scope.profile){
				if ($scope.profile.id){
					query.push('userid=' + $scope.profile.id);
				}
				if ($scope.profile.name){
					query.push('username=' + $scope.profile.name);
				}				
			}

			var querystring = query.length > 0 ? ('?' + query.join('&')) : '';

			var url = encodeURI('p#/ch/' + channelId + querystring);
/*
channelmode=yes|no|1|0	Whether or not to display the window in theater mode. Default is no. IE only
directories=yes|no|1|0	Obsolete. Whether or not to add directory buttons. Default is yes. IE only
fullscreen=yes|no|1|0	Whether or not to display the browser in full-screen mode. Default is no. A window in full-screen mode must also be in theater mode. IE only
height=pixels	The height of the window. Min. value is 100
left=pixels	The left position of the window. Negative values not allowed
location=yes|no|1|0	Whether or not to display the address field. Opera only
menubar=yes|no|1|0	Whether or not to display the menu bar
resizable=yes|no|1|0	Whether or not the window is resizable. IE only
scrollbars=yes|no|1|0	Whether or not to display scroll bars. IE, Firefox & Opera only
status=yes|no|1|0	Whether or not to add a status bar
titlebar=yes|no|1|0	Whether or not to display the title bar. Ignored unless the calling application is an HTML Application or a trusted dialog box
toolbar=yes|no|1|0	Whether or not to display the browser toolbar. IE and Firefox only
top=pixels	The top position of the window. Negative values not allowed
width=pixels
*/
			window.open(url, "_blank", "directories=no, location=no, menubar=no, status=no, titlebar=no, toolbar=no, scrollbars=no, resizable=yes, width=262, height=380");
		};

		connector.on('statusChanged', function(status){
			if (status === 'connected'){
				$scope.updateChannelList();
			}

			$scope.$apply(function(){
				$scope.serverStatus = status;
			});
		});
	}]);
});
