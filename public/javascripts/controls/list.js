'use strict';

define(['controllers', 'underscore', 'modules/socketConnector'], function (controllers, _, connector){

	controllers.controller('listCtrl', [ '$scope', function($scope){
		$scope.orderProp = 'age';
		$scope.serverStatus = 'connecting';
		
		$scope.createChannel = function(channel){
			connector.request('addUserToChannel', {channelId:channel, userName:'test'}, function(res){
				if (!res.err){
					var id = res.result;
					console.log(id);
				}
			});
		};

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

			window.location = '#/ch/' + channelId + querystring;
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
