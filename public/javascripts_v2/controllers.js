'use strict';

/* Controllers */

var bongtalkControllers = angular.module('bongtalk.controllers', []);

bongtalkControllers.controller('MainController', ['$scope', '$routeParams', '$http', 'bongtalk',
	function($scope, $routeParams, $http, bongtalk) {
		

		var bongtalk = Bongtalk('http://qufox.com');

		$scope.serverStatus = bongtalk.qufox.status;

		bongtalk.qufox.onStatusChanged(serverStatusChanged);
		function serverStatusChanged (status){
			$scope.$apply(function(){
				$scope.serverStatus = status;
			});
		};

	}]);

bongtalkControllers.controller('SessionController', ['$scope', '$routeParams', '$http', 'bongtalk',
	function($scope, $routeParams, $http, bongtalk) {		
		$scope.test = 'inner TEXT';
		$scope.talks = [];
		$scope.addContentTest = function() {
			$scope.talks.push({ message : 'test'});
		};
	}]);

bongtalkControllers.factory('bongtalk', [function(){
	return Bongtalk('http://qufox.com');
}]);